// Apple Music's own search page before anything is typed, in the library's
// place in the overview's slot while the shell's search entry is empty and
// has the keyboard (mediaMenu.js): "Recently Searched", the picks made out
// of searches (recents.js) as cards, with Clear; and "Browse Categories",
// Apple's own rooms (`am.py landing`), each a coloured tile with its
// picture, which picked opens as a page of shelves in the library
// (libraryView.js `openRoom`). Laid out as the shell lays its own results
// out — one rounded box under the entry, the results' own width — so it
// reads as the search's page rather than another tab.
//
// The categories are asked for once a session and kept; the engine is
// never started for them (`--no-start`), so with it down the page says so
// over what it has, and asks again the next time it is shown. A tile's
// picture is fetched a few at a time as the page is first shown, into the
// same cache the search's covers go to, and kept for the session.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {run} from './amctl.js';
import {SIGN_IN_HINT} from './library.js';
import {createLabel} from './widgets.js';
import {cacheRemoteArt} from './playerUtil.js';
import {createArtIcon} from './searchProvider.js';

// The shell's own results box: `#searchResultsContent`'s max-width, and
// the inset `.search-section-content` keeps either side (gnome-shell.css).
// Logical px, as is everything below.
const MAX_WIDTH = 1044;
const BOX_INSET = 12;
// `.mm-landing`'s padding in stylesheet.css — keep in step.
const BOX_PADDING = 18;
// Between cards and tiles; how narrow a card may get before a row holds one
// fewer; and how many a row holds at most, as Apple's page has it.
const GAP = 12;
const MIN_CARD = 180;
const MAX_PER_ROW = 5;
const CARD_ART = 44;
// A tile's shape: wide, as Apple's are.
const TILE_ASPECT = 0.56;
const FETCHES_AT_ONCE = 4;

const KIND_WORD = {artist: 'Artist', album: 'Album', song: 'Song', playlist: 'Playlist', station: 'Station', video: 'Music Video'};

// The categories, once asked for; and the pictures fetched, by id.
let categories = null;
const pictures = new Map();

export class LandingView {
    // `width` and `height` are the slot's, in stage px; `onActivate(item)`
    // is a recent pick opened again, `onCategory(category)` a category
    // picked, answered with a promise the tile waits on.
    constructor({width, height, recents = null, onActivate, onCategory, onOpenSettings = null}) {
        this._recents = recents;
        this._onActivate = onActivate;
        this._onCategory = onCategory;
        this._onOpenSettings = onOpenSettings;
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The box's width, and what its rows have to fill.
        const logical = Math.min(width / this._scale, MAX_WIDTH) - 2 * BOX_INSET;
        this._boxWidth = Math.round(logical * this._scale);
        this._contentWidth = logical - 2 * BOX_PADDING;
        this._loading = null;
        this._fetching = null;
        this._destroyed = false;

        this.actor = new St.ScrollView({
            style_class: 'mm-landing-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        // Centred in the slot, at the results' width: a scroll view's child
        // is a column, and a column places a child by its own alignment.
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.actor.child = column;
        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-landing',
            width: this._boxWidth,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        column.add_child(this._box);
        this._recentsSection = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-landing-section', x_expand: true});
        this._categoriesSection = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-landing-section', x_expand: true});
        this._box.add_child(this._recentsSection);
        this._box.add_child(this._categoriesSection);

        // Its own focus group, so the arrows walk its cards and tiles.
        global.focus_manager.add_group(this.actor);
        this.actor.connect('destroy', () => {
            this._destroyed = true;
            global.focus_manager.remove_group(this.actor);
            this._loading?.cancel();
            this._fetching?.cancel();
            this._recents?.disconnectObject(this);
        });
        this._recents?.connectObject('changed', () => this._buildRecents(), this);
        this._buildRecents();
        this._buildCategories();
    }

    destroy() {
        this.actor.destroy();
    }

    // On show: the picks as they stand, the categories if not yet asked
    // for, and the pictures still to fetch.
    refresh() {
        this._buildRecents();
        if (!categories)
            this._buildCategories();
        else
            this._fetchPictures();
    }

    focusFirst() {
        return this.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    // How many cards a row holds, and how wide each is.
    _rowShape() {
        const perRow = Math.max(2, Math.min(MAX_PER_ROW, Math.floor((this._contentWidth + GAP) / (MIN_CARD + GAP))));
        const width = Math.floor((this._contentWidth - GAP * (perRow - 1)) / perRow);
        return {perRow, width};
    }

    _header(title, {end = null} = {}) {
        const header = new St.BoxLayout({style_class: 'mm-landing-header', x_expand: true});
        header.add_child(createLabel(title, 'mm-landing-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        if (end)
            header.add_child(end);
        return header;
    }

    _rows(actors, width) {
        const {perRow} = this._rowShape();
        const rows = [];
        for (let i = 0; i < actors.length; i += perRow) {
            const row = new St.BoxLayout({style_class: 'mm-landing-row', x_expand: true});
            for (const actor of actors.slice(i, i + perRow)) {
                actor.width = Math.round(width * this._scale);
                row.add_child(actor);
            }
            rows.push(row);
        }
        return rows;
    }

    // ------------------------------------------------------------------
    // Recently Searched
    // ------------------------------------------------------------------
    _buildRecents() {
        const section = this._recentsSection;
        section.destroy_all_children();
        const items = this._recents?.items ?? [];
        section.visible = items.length > 0;
        if (!items.length)
            return;
        const clear = new St.Button({
            style_class: 'button flat mm-landing-clear',
            label: 'Clear',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        clear.connect('clicked', () => this._recents.clear());
        section.add_child(this._header('Recently Searched', {end: clear}));
        const {width} = this._rowShape();
        for (const row of this._rows(items.map(item => this._card(item)), width))
            section.add_child(row);
    }

    // A pick as Apple's page shows it: its cover, its title, and what it
    // is under it.
    _card(item) {
        const card = new St.Button({
            style_class: 'mm-recent-card',
            can_focus: true,
            track_hover: true,
            x_expand: false,
            accessible_name: item.title,
        });
        const content = new St.BoxLayout({style_class: 'mm-recent-card-content', x_expand: true});
        content.add_child(createArtIcon(item, CARD_ART));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-recent-card-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(createLabel(item.title, 'mm-recent-title'));
        // "Album · Four Year Strong", "Artist": an artist's subtitle is the
        // word already.
        const kind = KIND_WORD[item.kind] ?? '';
        const subtitle = item.subtitle ?? '';
        const what = [kind, subtitle.toLowerCase() === kind.toLowerCase() ? '' : subtitle].filter(Boolean).join(' · ');
        if (what)
            text.add_child(createLabel(what, 'mm-recent-subtitle'));
        content.add_child(text);
        card.set_child(content);
        card.connect('clicked', () => this._onActivate?.(item));
        return card;
    }

    // ------------------------------------------------------------------
    // Browse Categories
    // ------------------------------------------------------------------
    _buildCategories() {
        const section = this._categoriesSection;
        section.destroy_all_children();
        section.add_child(this._header('Browse Categories'));
        if (!categories) {
            section.add_child(createLabel('Loading…', 'mm-landing-hint'));
            this._load();
            return;
        }
        const {width} = this._rowShape();
        const height = Math.round(width * TILE_ASPECT);
        for (const row of this._rows(categories.map(category => this._tile(category, height)), width))
            section.add_child(row);
        this._fetchPictures();
    }

    async _load() {
        if (this._loading)
            return;
        const cancellable = this._loading = new Gio.Cancellable();
        let answer;
        try {
            answer = await run(['--no-start', 'landing'], {cancellable});
        } catch (e) {
            if (cancellable.is_cancelled() || this._destroyed)
                return;
            this._loading = null;
            this._sayWhyNot(e);
            return;
        }
        this._loading = null;
        if (this._destroyed)
            return;
        categories = Array.isArray(answer?.categories) ? answer.categories.filter(c => c?.id && c.title) : [];
        this._buildCategories();
    }

    // The engine's reasons for no categories, said where they would be.
    // Not kept: the next show asks again.
    _sayWhyNot(error) {
        const section = this._categoriesSection;
        section.destroy_all_children();
        section.add_child(this._header('Browse Categories'));
        const hint = error?.code === 'engine-down'
            ? 'Apple Music is not running. Press Sync in the library to start it, or turn on “Start engine automatically” in Settings.'
            : error?.code === 'not-signed-in' ? SIGN_IN_HINT
                : `Could not load the categories: ${error?.message ?? 'unknown error'}`;
        const label = new St.Label({text: hint, style_class: 'mm-landing-hint', x_expand: true});
        label.clutter_text.line_wrap = true;
        section.add_child(label);
    }

    // A tile: the category's colour, its picture over that once fetched,
    // and its name in the corner. Picked, it dims until its page is up.
    _tile(category, height) {
        const tile = new St.Button({
            style_class: 'mm-category',
            can_focus: true,
            track_hover: true,
            x_expand: false,
            height: Math.round(height * this._scale),
            accessible_name: category.title,
        });
        tile._category = category;
        this._paint(tile);
        const face = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        face.add_child(createLabel(category.title, 'mm-category-title', {
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        }));
        tile.set_child(face);
        tile.connect('clicked', async () => {
            if (!tile.reactive)
                return;
            tile.reactive = false;
            tile.opacity = 160;
            try {
                await this._onCategory?.(category);
            } finally {
                if (!this._destroyed) {
                    tile.reactive = true;
                    tile.opacity = 255;
                }
            }
        });
        return tile;
    }

    // The tile's own paint: St bakes the corner radius into a background
    // image only when both come in the same inline style (widgets.js).
    _paint(tile) {
        const category = tile._category;
        const picture = pictures.get(category.id);
        const parts = [`border-radius: 13px`];
        if (category.artColor)
            parts.push(`background-color: ${category.artColor}`);
        if (picture)
            parts.push(`background-image: url("file://${encodeURI(picture)}")`, 'background-size: cover');
        tile.set_style(`${parts.join('; ')};`);
    }

    // The pictures not yet fetched, a few at a time, each onto its tile as
    // it lands. Cancelled with the page, so a late one never touches a
    // tile that has gone.
    _fetchPictures() {
        this._fetching?.cancel();
        const cancellable = this._fetching = new Gio.Cancellable();
        const tiles = [];
        for (const row of this._categoriesSection.get_children()) {
            for (const tile of row.get_children()) {
                if (tile._category?.art && !pictures.has(tile._category.id))
                    tiles.push(tile);
            }
        }
        const next = () => {
            const tile = tiles.shift();
            if (!tile || cancellable.is_cancelled())
                return;
            cacheRemoteArt(tile._category.art, cancellable).then(path => {
                if (cancellable.is_cancelled())
                    return;
                if (path) {
                    pictures.set(tile._category.id, path);
                    this._paint(tile);
                }
                next();
            });
        };
        for (let i = 0; i < FETCHES_AT_ONCE; i++)
            next();
    }
}
