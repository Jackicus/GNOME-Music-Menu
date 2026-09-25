// One item up close: artwork and Play/Shuffle on the left, title, facts,
// summary and the track list (grouped into discs, or albums for an artist)
// on the right. A station has no groups: just the art, title, summary and a
// single big Play button.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {Duration, Ease, slideSwap, staggerIn} from './anim.js';
import {fillOnScroll} from './lazyList.js';
import {createArtwork, createActionButton, createLabel, createRow} from './widgets.js';
import {PANE_INSET, radiusStyle} from './shape.js';
import {run} from './amctl.js';
import {notifyFailure} from './notify.js';
import {adjustAnimationTime, ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

// What the pane keeps around its content, per frame; the stylesheet carries
// the same numbers. Sizes are worked out here rather than read back off an
// allocation, because the popup has to know how wide the side column will be
// before anything is on screen.
//
// Everything below is logical pixels, as the stylesheet's are: each is
// multiplied by the scale factor where it meets an allocation, and left alone
// where it goes into a CSS string, which St scales itself.
// The bare frame keeps less than the pane's own, because the panel around it
// adds `shape.js` PANE_INSET on top: what shows between the panel's edge and
// the artwork is the two together, and it comes to the same 32 either way.
const PADDING = {pane: 28, bare: 32 - PANE_INSET};

// The hero fills the pane's height, less its padding and the row of action
// buttons beneath it, up to this cap. It stops well short of a big screen:
// the popup is a panel the size of a folder's, not the work area, and the
// desktop pane keeps to the same proportions.
const HERO_MAX_HEIGHT = 560;
const HERO_RESERVED = 52 + 16;             // one row of action buttons and the gap
const HERO_MAX_WIDTH_FRACTION = 0.34;      // of the pane width
// The hero's floor on a small work area — see `_heroSize`.
const HERO_MIN = 132;
// 14px type at the stylesheet's line-height: 1.5. Clamped to three lines so
// a long editorial blurb never reserves more height than a short one shows,
// which otherwise leaves a fixed-size gap above the track list regardless
// of how much text there actually is.
const SUMMARY_LINE = 21;
const SUMMARY_LINES = 3;
// A disc runs to a couple of dozen tracks, an artist's album list to a
// handful of groups. The first batch is a screenful — and the one that is
// staggered in — and the rest follow as the list scrolls.
const FIRST_ROWS = 24;
const ROWS_PER_BATCH = 16;

export class DetailView {
    // `frame` is what the pane draws around itself: its own rounded, bordered
    // surface ('pane'), or nothing ('bare') when what holds it is the surface —
    // the shell's folder panel, in the popup. `onMenu` is called with
    // `{item, track, sourceActor}` for a row's ••• — the caller (app.js) opens
    // `itemMenu.js`'s popup menu at `sourceActor`.
    constructor({onMenu = null, frame = 'pane'} = {}) {
        this._onMenu = onMenu;
        this._frame = frame;
        this._section = null;
        this._groups = [];
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        // The rows of the current list, by catalogId (or id), for
        // `setNowPlayingTrack` to mark without rebuilding anything.
        this._trackRows = new Map();
        this._nowPlayingRow = null;
        this._nowPlayingKey = null;
        this._tabButtons = [];
        this._width = 0;
        this._height = 0;
        this._deferredList = 0;
        this._deferredMain = 0;
        this._columns = null;
        this._main = null;
        this._buildPendingMain = null;
        this._loading = false;
        this.hero = null;
        this.side = null;
        this.item = null;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
    }

    destroy() {
        this._cancelDeferred();
        this.actor.destroy();
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
    }

    _cancelDeferred() {
        if (this._deferredList) {
            GLib.source_remove(this._deferredList);
            this._deferredList = 0;
        }
        if (this._deferredMain) {
            GLib.source_remove(this._deferredMain);
            this._deferredMain = 0;
        }
    }

    // What the pane keeps between its frame and its columns, in physical
    // pixels — St has already scaled the stylesheet's copy of it. Public
    // because the popup sizes its panel around the side column and has to add
    // it back.
    get padding() {
        return (PADDING[this._frame] ?? PADDING.pane) * this._scale;
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // The corner the pane and everything that fills it to the edge — the
    // backdrop, its veil — are cut to. Inside the popup's panel that is the
    // panel's own curve less the frame it keeps, so the two stay concentric.
    get _paneRadius() {
        return this._frame === 'bare' ? 'paneInner' : 'pane';
    }

    // Hero size for this screen: as tall as the pane allows, capped so the
    // text column keeps its share of the width. Every lockup is square —
    // round artist artwork is the same square art, cropped by `shape.js`'s
    // `round` radius rather than a different aspect.
    _heroSize() {
        const scale = this._scale;
        const room = this._height - 2 * this.padding - HERO_RESERVED * scale;
        const byHeight = Math.min(HERO_MAX_HEIGHT * scale, room);
        const byWidth = Math.round(this._width * HERO_MAX_WIDTH_FRACTION);
        // A small screen at the smallest `detail-size` leaves less room than
        // the buttons under the artwork take, and the artwork would come out
        // at nothing or below it. HERO_MIN is the floor; the panel grows
        // around it, since it is sized from the column's own height.
        const height = Math.max(HERO_MIN * scale, Math.min(byHeight, byWidth));
        return {width: Math.round(height), height};
    }

    // `mainColumn` is when the second column — the title, the facts and the
    // list — joins the first: 'auto' as soon as the frame it was built on is
    // free, 'held' when whatever is opening the pane will call `revealMain()`
    // itself (the popup does, as it starts to widen onto it).
    populate(item, section, {mainColumn = 'auto'} = {}) {
        this._cancelDeferred();
        this.actor.destroy_all_children();
        this.item = item;
        this._section = section;
        this._loading = false;
        this._groups = item.groups ?? [];
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        this._trackRows = new Map();
        this._nowPlayingRow = null;
        this._main = null;
        this._tabButtons = [];

        const radius = this._paneRadius;
        const pane = new St.Widget({
            style_class: this._frame === 'bare' ? 'mm-pane mm-pane-bare' : 'mm-pane',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            style: radiusStyle(radius),
        });
        this.actor.add_child(pane);

        const columns = new St.BoxLayout({style_class: 'mm-pane-content', x_expand: true, y_expand: true});
        pane.add_child(columns);
        this._columns = columns;
        this.side = this._buildSide(item);
        columns.add_child(this.side);

        // Only the artwork and its buttons are built now. The rest is built on
        // the next idle, off the frames of the flight or the zoom that is
        // opening the pane, and the list inside it later still as it scrolls.
        this._buildPendingMain = () => this._buildMain(this.item);
        this._deferredMain = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._deferredMain = 0;
            this._addMain();
            if (mainColumn === 'auto')
                this.revealMain();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The same item again, now with what it lacked: its groups, fetched after
    // the pane opened on a shelf's or a search's item, which library.json
    // holds without a track list. The side column stays — its artwork is what
    // the pane zoomed out of — and the second column is built again in place
    // of the one that said "Loading…". Anything else showing is left alone.
    update(item) {
        if (!this.item || item?.id !== this.item.id)
            return;
        this.item = item;
        this._groups = item.groups ?? [];
        this._groupIndex = 0;
        this._tabButtons = [];
        this._trackRows = new Map();
        this._nowPlayingRow = null;
        if (this._buildPendingMain)
            return;   // not built yet: the pending build reads this.item
        if (this._deferredList) {
            GLib.source_remove(this._deferredList);
            this._deferredList = 0;
        }
        // A built column is one on its way in or already there — nothing
        // builds it but revealMain — so the one that replaces it is simply
        // shown, whatever frame of the fade the old one was on.
        this._list = null;
        this._listHost = null;
        this._main?.destroy();
        this._main = this._buildMain(item);
        this._columns.add_child(this._main);
        this._fillList(0);
    }

    // What an empty group says: nothing, or nothing yet.
    get _emptyText() {
        return this._loading ? 'Loading…' : 'Nothing here yet.';
    }

    // While a groupless item's list is on its way (app.js `_loadGroups`).
    setLoading(loading) {
        this._loading = !!loading;
        if (this._list instanceof St.Label)
            this._list.text = this._emptyText;
    }

    // A station is what has no track list; anything else without groups is
    // simply one whose list has not been fetched yet.
    get _isStation() {
        return this.item?.kind === 'station';
    }

    // Build the second column, hidden, if it is not there yet.
    _addMain() {
        if (!this._buildPendingMain)
            return;
        const build = this._buildPendingMain;
        this._buildPendingMain = null;
        if (this._deferredMain) {
            GLib.source_remove(this._deferredMain);
            this._deferredMain = 0;
        }
        this._main = build();
        this._main.opacity = 0;
        this._columns.add_child(this._main);
    }

    // Fade the second column in — as the popup's panel opens out onto it, or
    // on its own once built when the pane is already the width it will be.
    // The list under it follows the fade rather than joining it: see _fillList.
    revealMain({delay = 0} = {}) {
        this._addMain();
        this._main?.ease({opacity: 255, delay, duration: Duration.NORMAL, mode: Ease.OUT});
        this._fillList(delay + Duration.NORMAL);
    }

    // The first screenful of the group list, once the pane has stopped moving.
    // It is the one piece of building left that would be felt — two dozen rows
    // at once, where everything above it is a handful of actors — so the zoom
    // and the widen that opened the pane, or the hero flight into it, get
    // every frame before this to themselves. A timer and not an idle: an idle
    // falls in the middle of an animation, which is the whole of what this
    // avoids. Whatever fills it afterwards is `lazyList` as it scrolls.
    _fillList(after) {
        if (this._deferredList || this._list || !this._listHost)
            return;
        this._deferredList = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            adjustAnimationTime(after), () => {
                this._deferredList = 0;
                this._showGroup(this._groupIndex, {animate: false});
                return GLib.SOURCE_REMOVE;
            });
    }

    // And back out, as the panel closes back down to its artwork.
    hideMain({duration = Duration.FAST} = {}) {
        this._main?.ease({opacity: 0, duration, mode: Ease.OUT});
    }

    // Mark the row playing `catalogIdOrId` (a track's catalogId, or its id
    // when it has none) across whatever group is showing — or clear the mark
    // when nothing here is playing. Called from app.js on the player's
    // 'changed'; a track outside the current group, or outside this item
    // altogether, just means no row lights up.
    setNowPlayingTrack(catalogIdOrId) {
        this._nowPlayingKey = catalogIdOrId ?? null;
        if (this._nowPlayingRow) {
            this._nowPlayingRow.setNowPlaying(false);
            this._nowPlayingRow = null;
        }
        const row = this._nowPlayingKey != null ? this._trackRows.get(this._nowPlayingKey) : null;
        if (row) {
            row.setNowPlaying(true);
            this._nowPlayingRow = row;
        }
    }

    // Left: artwork, then Play/Shuffle — or, for a station, one big Play.
    _buildSide(item) {
        // x_expand is set explicitly to false: Clutter otherwise treats a parent
        // as expanding when any descendant expands (the buttons do), and the
        // side column would swallow half of the free width.
        const side = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-detail-side', x_expand: false, y_expand: true});

        const {width: heroW, height: heroH} = this._heroSize();
        this.hero = createArtwork({
            path: item.art,
            title: item.title,
            icon: this._section?.icon ?? 'audio-x-generic-symbolic',
            width: heroW,
            height: heroH,
            styleClass: 'mm-art mm-hero',
            radius: item.kind === 'artist' ? 'round' : 'hero',
        });
        side.add_child(this.hero);

        if (!item.play)
            return side;

        const play = (label, extra, styleClass) => {
            const button = createActionButton({
                label,
                icon: 'media-playback-start-symbolic',
                ...(styleClass ? {styleClass} : {}),
            });
            button.set_x_expand(true);
            button.connect('clicked', () => run(['play', item.play.kind, item.play.id, ...extra]).catch(notifyFailure));
            return button;
        };

        if (this._isStation) {
            // A station: nothing to shuffle, so just the one big button.
            side.add_child(play('Play', [], 'button default mm-action mm-action-big'));
            return side;
        }

        const actions = new St.BoxLayout({style_class: 'mm-detail-actions', x_expand: true});
        actions.add_child(play('Play', []));
        const shuffle = createActionButton({label: 'Shuffle', icon: 'media-playlist-shuffle-symbolic', styleClass: 'button mm-action-secondary'});
        shuffle.set_x_expand(true);
        shuffle.connect('clicked', () => run(['play', item.play.kind, item.play.id, '--shuffle']).catch(notifyFailure));
        actions.add_child(shuffle);
        side.add_child(actions);

        return side;
    }

    // Right: title, artist, facts line, summary, group tabs, list.
    _buildMain(item) {
        const main = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, style_class: 'mm-detail-main'});
        const isStation = this._isStation;

        main.add_child(createLabel(item.title, 'mm-detail-title'));

        if (!isStation && item.subtitle)
            main.add_child(createLabel(item.subtitle, 'mm-detail-subtitle'));

        if (!isStation) {
            const facts = [item.genre, item.year ? String(item.year) : null, item.countLabel].filter(Boolean);
            if (facts.length)
                main.add_child(createLabel(facts.join(' · '), 'mm-facts-line'));
        }

        if (item.summary) {
            const summary = new St.Label({text: item.summary, style_class: 'mm-summary', x_expand: true});
            summary.clutter_text.line_wrap = true;
            summary.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            // Height bounds the text so Pango ellipsises the last visible line.
            summary.height = SUMMARY_LINE * this._scale * SUMMARY_LINES;
            summary.y_expand = false;
            main.add_child(summary);
        }

        // A station has no groups and no track list: art, title, summary,
        // Play, and nothing below it.
        if (isStation)
            return main;

        // Groups (discs, or albums for an artist) are tabs, hidden when
        // there is only the one — a single-disc album reads as a plain list.
        if (this._groups.length > 1)
            main.add_child(this._buildTabs());

        this._listHost = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        main.add_child(this._listHost);
        // The list itself is `revealMain`'s to start, once the pane has
        // landed (_fillList).
        return main;
    }

    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'mm-group-tabs', x_expand: true});
        this._groups.forEach((group, i) => {
            const tab = new St.Button({
                // The theme's button: `:checked` is what marks the open tab.
                style_class: 'button mm-group-tab',
                label: group.name,
                toggle_mode: true,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            tab.connect('clicked', () => {
                if (!tab.checked) {
                    tab.checked = true;
                    return;
                }
                this._showGroup(i, {animate: true});
            });
            this._tabButtons.push(tab);
            tabs.add_child(tab);
        });
        return tabs;
    }

    _showGroup(index, {animate}) {
        const previous = this._groupIndex;
        this._groupIndex = index;
        this._tabButtons.forEach((tab, i) => (tab.checked = i === index));

        const group = this._groups[index];
        const old = this._list;
        const list = group?.entries?.length
            ? this._buildList(group)
            : new St.Label({text: this._emptyText, style_class: 'mm-empty-hint', x_expand: true});
        this._list = list;
        this._listHost.add_child(list);

        if (!animate) {
            old?.destroy();
            return;
        }
        slideSwap(old, list, index >= previous ? 1 : -1, {distance: 24, onComplete: () => old?.destroy()});
    }

    _buildList(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'vfade mm-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'mm-list'});
        scroll.set_child(box);

        const item = this.item;
        const entries = group.entries;
        // A compilation's or an artist's rows need the artist under the
        // title; an album's own tracklist already says it once, at the top.
        const showArtist = item.kind !== 'album';
        const trackRows = this._trackRows = new Map();
        this._nowPlayingRow = null;
        let next = 0;
        let first = true;
        fillOnScroll(scroll, () => {
            const limit = Math.min(entries.length, next + (first ? FIRST_ROWS : ROWS_PER_BATCH));
            const batch = [];
            for (; next < limit; next++) {
                const entry = entries[next];
                const key = entry.catalogId ?? entry.id;
                const row = createRow({
                    index: entry.trackNumber,
                    title: entry.title,
                    subtitle: showArtist ? entry.artist : null,
                    explicit: entry.explicit,
                    duration: entry.durationLabel,
                    nowPlaying: key != null && key === this._nowPlayingKey,
                    onActivate: () => run(['play', group.play.kind, group.play.id, '--start-with', String(entry.index)]).catch(notifyFailure),
                    onMenu: sourceActor => this._onMenu?.({item, track: entry, sourceActor}),
                });
                if (key != null) {
                    trackRows.set(key, row);
                    if (key === this._nowPlayingKey)
                        this._nowPlayingRow = row;
                }
                // Keyboard focus has to drag the view after it, or a Tab past
                // the fold never scrolls and so never tops the list up.
                row.connect('key-focus-in', () => ensureActorVisibleInScrollView(scroll, row));
                batch.push(row);
                box.add_child(row);
            }
            // Only the arriving screenful is staggered; the rest are appended
            // below the fold, where an animation would go unseen.
            if (first)
                staggerIn(batch, {step: 12, cap: 160, fromY: 8});
            first = false;
            return next < entries.length;
        });
        return scroll;
    }
}
