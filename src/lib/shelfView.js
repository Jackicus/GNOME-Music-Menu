// Listen Now: a vertical list of shelves, each a title over one row of the
// shell's own app grid (mediaGrid.js). A shelf therefore pages the way the
// app grid does — the arrows at its sides, the dots beneath, the wheel and a
// swipe all turn its page — and its tiles are the very tiles every other tab
// shows, at the same size, since the shape is asked of the same box. "See
// All" opens a shelf out from one row to the `rows` a tab has, still paged,
// and back again.
//
// Between shelves the arrows are St's: the focus group around the whole
// library (the overview's, or the surface's) navigates them in the capture
// phase, before anything here sees a key, and its search crosses from one
// row into the next. This view only keeps the row that takes the keyboard
// in sight, and answers the few questions a grid does for its host.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {ARROWS_SHARE, createMediaView, gridShapeFor, pageHeightFor} from './mediaGrid.js';
import {createLabel} from './widgets.js';

// From a page's edge to its first tile's artwork: the `icon-grid` theme's
// page-padding-left and the `overview-tile`'s own padding. Logical px.
const PAGE_INSET = 18 + 12;

class Shelf {
    constructor(shelf, {section, width, shape, rows, callbacks}) {
        this._section = section;
        this._width = width;
        this._shape = shape;
        this._rows = Math.max(1, rows);
        this._callbacks = callbacks;
        this._items = shelf.items ?? [];
        this._expanded = false;
        this.view = null;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-shelf',
            x_expand: true,
        });

        // The title starts where the row's first tile does: past the arrows'
        // share of the width and the page's inset. St scales the style.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const inset = Math.round(width * ARROWS_SHARE / 2 / scale) + PAGE_INSET;
        const header = new St.BoxLayout({style_class: 'mm-shelf-header', x_expand: true});
        header.style = `margin: 0 ${inset}px;`;
        header.add_child(createLabel(shelf.title ?? '', 'mm-shelf-title', {x_expand: true}));
        // Nothing to open out when one row holds the lot, or the setting
        // allows no more rows than the one.
        if (this._items.length > shape.columns && this._rows > 1) {
            this._seeAll = new St.Button({
                style_class: 'button flat mm-shelf-see-all',
                label: 'See All ›',
                can_focus: true,
                track_hover: true,
            });
            this._seeAll.connect('clicked', () => this._setExpanded(!this._expanded));
            header.add_child(this._seeAll);
        }
        this.actor.add_child(header);

        this._host = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this.actor.add_child(this._host);
        this._build(1);
    }

    // The row, or the grid: the app grid's view over this shelf's items, `rows`
    // deep, as tall as that many rows of the shared tile come to.
    _build(rows) {
        this.view?.destroy();
        const shape = {...this._shape, rows};
        const view = createMediaView({
            section: this._section,
            items: this._items,
            shape,
            onActivate: this._callbacks.onActivate,
            onContextMenu: this._callbacks.onContextMenu,
        });
        view.y_expand = false;
        view.height = pageHeightFor(shape);
        this._host.add_child(view);
        this.view = view;
    }

    _setExpanded(expanded) {
        if (expanded === this._expanded)
            return;
        this._expanded = expanded;
        this._seeAll.label = expanded ? 'Show Less ‹' : 'See All ›';
        this._build(expanded ? this._rows : 1);
    }

    get firstTile() {
        return this.view.tileFor(this._items[0]?.id);
    }
}

export class ShelfView {
    // `width` and `height` are the page's own budget (libraryView.js
    // `_page`, already short of the header and the footer), in physical px:
    // the height sizes the tiles as it would a tab's grid, so a shelf's tiles
    // are the same as an album's, and it caps the ScrollView, which is
    // top-aligned in the stack rather than filling it (the stack is left
    // unclipped for a grid's hovered edge tiles) so a shelf ends above the
    // player bar instead of running behind it.
    constructor({section, shelves = [], width, height = 0, columns, rows, onActivate, onContextMenu}) {
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
        this._scroll.connect('destroy', () => this._release());

        const shape = gridShapeFor({width, height, columns, rows, aspect: section.aspect});
        this._shelves = shelves
            .filter(shelf => shelf.items?.length)
            .map(shelf => new Shelf(shelf, {section, width, shape, rows, callbacks: {onActivate, onContextMenu}}));
        for (const shelf of this._shelves)
            this._list.add_child(shelf.actor);

        // The keyboard drags the list after it: a tile focused below the fold
        // — from the shelf above, or on Tab — would otherwise stay there.
        this._focusId = global.stage.connect('notify::key-focus', () => {
            const focus = global.stage.get_key_focus();
            if (focus && this._list.contains(focus))
                ensureActorVisibleInScrollView(this._scroll, focus);
        });
    }

    get actor() {
        return this._scroll;
    }

    // Where a navigation key lands when nothing inside is focused yet — the
    // host's step down from the tabs, as a grid's own focusFirst() is.
    focusFirst() {
        return this._shelves[0]?.view.focusFirst() ?? false;
    }

    // Whether `actor` is on the first shelf's first row: an arrow up from
    // there is the tabs' (libraryView.js).
    atTopRow(actor) {
        const first = this._shelves[0];
        return !!first && first.actor.contains(actor) && first.view.atTopRow(actor);
    }

    // A page on or back, on whichever shelf holds the keyboard, or the first.
    pageBy(delta) {
        const focus = global.stage.get_key_focus();
        const shelf = this._shelves.find(s => s.actor.contains(focus)) ?? this._shelves[0];
        return shelf?.view.pageBy(delta) ?? false;
    }

    // The tile showing `itemId` on whichever shelf has built it: where the
    // detail pane's artwork flies back to.
    tileFor(itemId) {
        for (const shelf of this._shelves) {
            const tile = shelf.view.tileFor(itemId);
            if (tile)
                return tile;
        }
        return null;
    }

    // Once, whether through destroy() or the actor going on its own.
    _release() {
        if (this._focusId) {
            global.stage.disconnect(this._focusId);
            this._focusId = 0;
        }
    }

    destroy() {
        this._release();
        this._scroll.destroy();
    }
}
