// Listen Now: a vertical list of shelves — Heavy Rotation, Recently Added and
// the rest of `library.json`'s `shelves` — each a title row over its items.
// A shelf starts as one horizontally-scrolling row, the way the Apple Music
// web player shows it (design/index.html's `.content-shelf`); its "See All"
// button swaps that row for a wrapping grid that scrolls with the page
// instead of sideways. Nothing here is the shell's own — Listen Now has no
// grid of its own kind (library.js SECTIONS, `shelves: true`) — so the row,
// the grid and the tile are all built by hand rather than borrowed.
//
// A tile is plain St, not AppViewItem: a shelf is a handful of rows of a
// few dozen things each, not the thousand-item library grid mediaGrid.js is
// built for, so there is no paging or icon-grid machinery to inherit here.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {Duration, Ease} from './anim.js';
import {createArtwork, createLabel} from './widgets.js';

// A screenful is built straight away so a shelf never shows empty while it
// fills in; the rest trickle in a few at a time on idle so opening Listen Now
// never stalls the compositor building fifty tiles nobody has scrolled to.
// This is a fixed schedule rather than lazyList.js's scroll-driven top-up
// (fillOnScroll): a shelf's row scrolls sideways, not with the page, so there
// is no one vertical adjustment to watch, and the brief asks for exactly this
// shape — a first batch, then idle batches — rather than a scroll trigger.
const IDLE_BATCH = 6;
// A conservative per-tile width (tile plus row gap) used only to guess how
// many tiles make up "a screenful": guessing high costs a few extra tiles
// built synchronously, guessing low just means idle tops the row up sooner,
// so nothing here has to be exact.
const ROW_GAP = 16;

// The icon a placeholder tile falls back to when an item has no artwork,
// matching the section icons in library.js so a missing cover reads the same
// way here as it does in that item's own tab.
const KIND_ICON = {
    album: 'media-optical-cd-audio-symbolic',
    playlist: 'view-list-symbolic',
    artist: 'avatar-default-symbolic',
    station: 'radio-symbolic',
};

// How far a hovered tile's artwork grows. Small enough to read as a nudge,
// not a zoom, and driven by pointer-crossing events rather than `track_hover`
// (the Gotchas): `track_hover` restyles the widget and every child of it on
// each enter and leave, which is the cost of a hover multiplied by however
// many tiles a shelf holds. A plain property ease on the artwork alone, with
// no `:hover` rule for it in the stylesheet, costs one actor rather than a
// subtree.
const HOVER_SCALE = 1.04;

// Scroll `actor` into view along `scrollView`'s own axis (`hadjustment` or
// `vadjustment`), walking up from `actor` to `scrollView` summing allocation
// boxes as `ensureActorVisibleInScrollView` does for the vertical case. That
// shell helper only ever reads `vadjustment`, so a shelf's horizontal row
// needs this counterpart; unlike the shell's version this returns quietly
// rather than throwing when `actor` is not (yet) inside `scrollView` at all —
// true of every tile in whichever of a shelf's two layouts is not showing.
function ensureVisibleAlong(scrollView, actor, adjustmentName, startKey, endKey) {
    const adjustment = scrollView[adjustmentName];
    if (!adjustment)
        return;
    const [value, , upper, , , pageSize] = adjustment.get_values();

    let box = actor.get_allocation_box();
    let start = box[startKey], end = box[endKey];
    let parent = actor.get_parent();
    while (parent && parent !== scrollView) {
        box = parent.get_allocation_box();
        start += box[startKey];
        end += box[startKey];
        parent = parent.get_parent();
    }
    if (!parent)
        return;

    let target;
    if (start < value)
        target = Math.max(0, start);
    else if (end > value + pageSize)
        target = Math.min(upper, end - pageSize);
    else
        return;
    adjustment.ease(target, {mode: Clutter.AnimationMode.EASE_OUT_QUAD, duration: Duration.NORMAL});
}

const ensureVisibleHorizontal = (scrollView, actor) =>
    ensureVisibleAlong(scrollView, actor, 'hadjustment', 'x1', 'x2');

// A mouse wheel over a horizontally-scrolling row moves it sideways rather
// than doing nothing: `St.ScrollView` only ever wires a vertical wheel to a
// vertical adjustment on its own.
function wireWheelToHorizontal(scrollView) {
    scrollView.connect('scroll-event', (_actor, event) => {
        const adjustment = scrollView.hadjustment;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH:
            delta = event.get_scroll_delta()[1];
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        const step = Math.max(adjustment.step_increment, adjustment.page_size * 0.3);
        adjustment.value = Math.min(Math.max(adjustment.lower, adjustment.value + delta * step),
            adjustment.upper - adjustment.page_size);
        return Clutter.EVENT_STOP;
    });
}

// One tile: square (or, for an artist, round — shape.js's `round` part, a
// full circle independent of `corner-radius`, exactly as a pill is)
// artwork over a title and subtitle. A button in its own right rather than a
// bin around one, so it takes the keyboard and paints its own focus ring
// (`.mm-shelf-tile:focus` in the stylesheet).
function buildTile(item, tileSize, {onActivate, onContextMenu}) {
    const tile = new St.Button({
        style_class: 'mm-shelf-tile',
        can_focus: true,
        reactive: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START,
    });

    const content = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'mm-shelf-tile-content',
    });

    const art = createArtwork({
        path: item.art,
        title: item.title,
        icon: KIND_ICON[item.kind] ?? 'audio-x-generic-symbolic',
        width: tileSize,
        height: tileSize,
        radius: item.kind === 'artist' ? 'round' : 'art',
    });
    art.set_pivot_point(0.5, 0.5);
    content.add_child(art);
    // `width` has to sit on the label itself: a non-expanding child of a
    // BoxLayout is allocated exactly its own preferred size, so without this
    // Pango never gets a width to ellipsize against and a long title just
    // overflows the tile instead of being cut off (widgets.js's placeholder
    // title sets its own width for the same reason).
    content.add_child(createLabel(item.title, 'mm-shelf-tile-title', {width: tileSize}));
    if (item.subtitle)
        content.add_child(createLabel(item.subtitle, 'mm-shelf-tile-subtitle', {width: tileSize}));

    tile.set_child(content);

    // Hover is the artwork's own property, eased on the crossing events
    // themselves (see HOVER_SCALE above) — nothing here touches a CSS
    // pseudo-class, so nothing here restyles anything but this one actor.
    tile.connect('enter-event', () => {
        art.remove_all_transitions();
        art.ease({scale_x: HOVER_SCALE, scale_y: HOVER_SCALE, duration: Duration.FAST, mode: Ease.OUT});
        return Clutter.EVENT_PROPAGATE;
    });
    tile.connect('leave-event', () => {
        art.remove_all_transitions();
        art.ease({scale_x: 1, scale_y: 1, duration: Duration.FAST, mode: Ease.OUT});
        return Clutter.EVENT_PROPAGATE;
    });

    tile.connect('clicked', () => onActivate?.(item, art));
    // The theme's flat button only ever fires `clicked` for the primary
    // button (its own `button-mask`); a secondary click needs the raw signal.
    tile.connect('button-press-event', (_actor, event) => {
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            onContextMenu?.(item, tile);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
    tile.connect('key-press-event', (_actor, event) => {
        if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Menu) {
            onContextMenu?.(item, tile);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    return tile;
}

// One shelf: a title row and its tiles, in one of two layouts picked by its
// "See All" button — a single horizontally-scrolling row (`hfade`, the
// shell's own edge-fade class for exactly this shape, switcherPopup.js) or a
// grid that wraps and scrolls with the rest of the page. Tiles already built
// move between the two rather than being rebuilt, so toggling costs nothing
// once a shelf has filled in.
class Shelf {
    constructor(shelf, tileSize, callbacks, outerScroll, idleSources) {
        this._tileSize = tileSize;
        this._callbacks = callbacks;
        this._outerScroll = outerScroll;
        this._idleSources = idleSources;
        this._items = shelf.items ?? [];
        this._tiles = [];
        this._expanded = false;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-shelf',
            x_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'mm-shelf-header', x_expand: true});
        header.add_child(createLabel(shelf.title ?? '', 'mm-shelf-title', {x_expand: true}));
        const seeAll = new St.Button({
            style_class: 'button flat mm-shelf-see-all',
            label: 'See All ›',
            can_focus: true,
            track_hover: true,
        });
        seeAll.connect('clicked', () => this._setExpanded(!this._expanded));
        header.add_child(seeAll);
        this._seeAll = seeAll;
        this.actor.add_child(header);

        this._rowBox = new St.BoxLayout({style_class: 'mm-shelf-row-box'});
        this._rowScroll = new St.ScrollView({style_class: 'hfade mm-shelf-row'});
        this._rowScroll.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
        this._rowScroll.set_child(this._rowBox);
        wireWheelToHorizontal(this._rowScroll);
        this.actor.add_child(this._rowScroll);

        this._gridBox = new St.Widget({
            style_class: 'mm-shelf-grid',
            x_expand: true,
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_spacing: ROW_GAP,
                row_spacing: ROW_GAP,
                homogeneous: false,
            }),
        });
        this._gridBox.hide();
        this.actor.add_child(this._gridBox);

        // The page that holds a shelf is rebuilt by destroying its actor
        // (libraryView.js `_measureFooter`), not through ShelfView.destroy(),
        // so the idle that is still filling this shelf has to go with the
        // actor or it appends its next batch into a disposed box.
        this._idleSource = 0;
        this.actor.connect('destroy', () => this._stopFilling());

        this._buildInitial();
    }

    _stopFilling() {
        if (!this._idleSource)
            return;
        GLib.source_remove(this._idleSource);
        this._idleSources.delete(this._idleSource);
        this._idleSource = 0;
    }

    get firstTile() {
        return this._tiles[0] ?? null;
    }

    // A screenful now, the rest a few at a time on idle (module doc above).
    _buildInitial() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const perScreen = Math.max(4, Math.ceil((global.stage.width || 1280 * scale) /
            (this._tileSize + ROW_GAP * scale)) + 2);
        let next = this._appendBatch(0, perScreen);
        if (next >= this._items.length)
            return;

        const step = () => {
            next = this._appendBatch(next, IDLE_BATCH);
            if (next < this._items.length) {
                return GLib.SOURCE_CONTINUE;
            }
            this._idleSources.delete(source);
            this._idleSource = 0;
            return GLib.SOURCE_REMOVE;
        };
        const source = GLib.idle_add(GLib.PRIORITY_LOW, step);
        this._idleSource = source;
        this._idleSources.add(source);
    }

    _appendBatch(from, count) {
        const to = Math.min(this._items.length, from + count);
        const target = this._expanded ? this._gridBox : this._rowBox;
        for (let i = from; i < to; i++) {
            const item = this._items[i];
            const tile = buildTile(item, this._tileSize, this._callbacks);
            tile.connect('key-focus-in', () => {
                ensureActorVisibleInScrollView(this._outerScroll, tile);
                if (!this._expanded)
                    ensureVisibleHorizontal(this._rowScroll, tile);
            });
            this._tiles.push(tile);
            target.add_child(tile);
        }
        return to;
    }

    _setExpanded(expanded) {
        if (expanded === this._expanded)
            return;
        this._expanded = expanded;
        this._seeAll.label = expanded ? 'Show Less ‹' : 'See All ›';
        const target = expanded ? this._gridBox : this._rowBox;
        for (const tile of this._tiles) {
            tile.get_parent()?.remove_child(tile);
            target.add_child(tile);
        }
        this._rowScroll.visible = !expanded;
        this._gridBox.visible = expanded;
    }
}

// Listen Now, in full: a vertical `St.ScrollView` of shelves. One focus group
// around the whole list (`global.focus_manager.add_group`, as mediaGrid.js
// registers the library grid) rather than one per shelf, so St's own
// direction-based search is what carries an arrow both along a row and down
// to the next shelf — the "nearest" group around a focused tile has to be
// this one for the arrows to leave a shelf at all.
export class ShelfView {
    // `height` is the page's own budget (libraryView.js `_page`, already
    // short of the header and the footer), in physical px. Given it, the
    // ScrollView takes exactly that much room and stops there — top-aligned
    // rather than filling the stack that hosts it, which is left unclipped
    // on purpose for a grid's hovered edge tiles — so a shelf ends above the
    // player bar instead of running behind it; anything taller than that
    // just scrolls, which is the ScrollView's job either way.
    constructor({shelves = [], tileSize, height = 0, onActivate, onContextMenu}) {
        this._idleSources = new Set();

        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-shelf-list',
            x_expand: true,
        });
        this._scroll = new St.ScrollView({style_class: 'vfade mm-shelf-scroll', x_expand: true, y_expand: true});
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scroll.set_child(this._list);
        if (height > 0) {
            this._scroll.y_expand = false;
            this._scroll.y_align = Clutter.ActorAlign.START;
            this._scroll.height = height;
        }

        global.focus_manager.add_group(this._list);
        this._scroll.connect('destroy', () => this._release());

        this._shelves = shelves
            .filter(shelf => shelf.items?.length)
            .map(shelf => new Shelf(shelf, tileSize, {onActivate, onContextMenu}, this._scroll, this._idleSources));
        for (const shelf of this._shelves)
            this._list.add_child(shelf.actor);
    }

    get actor() {
        return this._scroll;
    }

    // Where a navigation key lands when nothing inside is focused yet — the
    // host's step down from the tabs, as a grid's own focusFirst() is.
    focusFirst() {
        const tile = this._shelves[0]?.firstTile;
        if (!tile)
            return false;
        tile.grab_key_focus();
        return true;
    }

    // Once, whether through destroy() or the actor going on its own.
    _release() {
        if (this._released)
            return;
        this._released = true;
        // Through the shelves, so each forgets its own source: the actor's
        // destroy handlers run before its children go, and a shelf that
        // still held an id would remove it a second time.
        for (const shelf of this._shelves)
            shelf._stopFilling();
        for (const source of this._idleSources)
            GLib.source_remove(source);
        this._idleSources.clear();
        global.focus_manager.remove_group(this._list);
    }

    destroy() {
        this._release();
        this._scroll.destroy();
    }
}
