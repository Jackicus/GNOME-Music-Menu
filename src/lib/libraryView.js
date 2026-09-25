// The library: tabs between its sections over one grid per section, each
// built the first time its tab is chosen and kept, so switching is a matter of
// which one shows. Every place the library is browsed holds one of these — the
// page on the wallpaper (app.js), the overview's app-grid slot (mediaMenu.js),
// the folder's panel (libraryWindow.js) — and says only what goes around it.
//
// The keyboard walks a grid because the grid is a focus group of its own
// (mediaGrid.js), which is also why an arrow up from its top row has nowhere
// to go: St navigates within the nearest group and no further. So the view
// takes that one step itself, up onto the tabs, and the step back down into
// the grid — which lets a remote with nothing but arrows switch libraries.
//
// Listen Now is not one grid: its tab hosts a ShelfView, a vertical scroll of
// shelves that are each a one-row grid of the same tiles, and it answers the
// same few methods a grid does (`focusFirst`, `atTopRow`, `pageBy`, `tileFor`)
// on their behalf. The empty state answers none, so they are asked with `?.`.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {ensureStyleDeep} from './anim.js';
import {createMediaView} from './mediaGrid.js';
import {ShelfView} from './shelfView.js';
import {createEmptyState, createHeader, createIconButton} from './widgets.js';

// `.mm-header`'s height (52px) plus its margin-bottom (24px) in stylesheet.css
// — keep in step — taken off the top before anything under it is sized.
// Logical px.
export const HEADER_ALLOWANCE = 76;

export class LibraryView {
    // `sections` are the tabs, in order, and `active` the one to show first.
    // `width` and `height` are the whole view's, header included, in physical
    // px. `onSwitch` hears of a tab chosen here, so whoever holds the view can
    // open on the same one next time; `onBack` and `end` go to the header
    // (createHeader), and `onOpenSettings` is the empty state's way out.
    // `onContextMenu` is a tile's secondary click or Menu key, in a grid and
    // in a shelf alike. `onSync` runs a sync and answers with its promise;
    // the header's sync button is held down until that settles.
    constructor({sections, itemsFor, active, width, height, columns, rows, onActivate, onContextMenu, onSwitch, onBack, end, onOpenSettings, onSync = null}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._width = width;
        this._height = height;
        this._columns = columns;
        this._rows = rows;
        this._onActivate = onActivate;
        this._onContextMenu = onContextMenu;
        this._onSwitch = onSwitch;
        this._onOpenSettings = onOpenSettings;
        // A section's grid, or its empty state, by key; `view` is null for
        // the empty state, and — for a grid or a shelf — is the object that
        // holds the keyboard behaviour, not necessarily `actor` itself.
        this._pages = new Map();
        this._prebuildIdle = 0;
        this._key = this._sectionFor(active)?.key ?? null;
        // The footer slot under the grid (a player bar), and how much height
        // it takes off every page's budget.
        this._footer = null;
        this._footerHeight = 0;
        this._footerRecheckId = 0;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        // A library's own way to ask for a fresh library.json without
        // waiting for the automatic timer (app.js) or the preferences.
        this._syncButton = createIconButton('view-refresh-symbolic', {accessibleName: 'Sync library'});
        this._syncButton.connect('clicked', () => this._sync(onSync));

        this.header = createHeader({
            sections,
            active: this._key,
            onSwitch: key => {
                this.show(key);
                this._onSwitch?.(key);
            },
            onBack,
            end: [...(end ?? []), this._syncButton],
        });
        this.actor.add_child(this.header.actor);

        // Where the grids take turns, and where the detail pane goes when it
        // takes a grid's place (app.js). Unclipped on purpose: the grid
        // overhangs it slightly so hovered edge tiles are not cut off.
        this.stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this.stack);

        this.actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this.actor.connect('destroy', () => {
            if (this._prebuildIdle)
                GLib.source_remove(this._prebuildIdle);
            this._prebuildIdle = 0;
            if (this._footerRecheckId)
                GLib.source_remove(this._footerRecheckId);
            this._footerRecheckId = 0;
            this._pages.clear();
        });
    }

    destroy() {
        // The footer (a player bar) is a singleton shared across rebuilds:
        // detached rather than taken down with this instance's actors.
        if (this._footer && this._footer.get_parent() === this.actor)
            this.actor.remove_child(this._footer);
        this._footer = null;
        this.actor.destroy();
    }

    // The section on show.
    get key() {
        return this._key;
    }

    // Its grid or shelf, or null when it has nothing in it.
    get currentView() {
        return this._pages.get(this._key)?.view ?? null;
    }

    // `key`'s tab, or the one showing when there is no such section.
    show(key, {reveal = false} = {}) {
        this._key = this._sectionFor(key)?.key ?? this._key;
        if (!this._key)
            return;
        this.header.setActive(this._key);
        const page = this._page(this._key);
        for (const other of this._pages.values())
            other.actor.visible = other === page;
        if (reveal)
            page.view?.reveal?.();
    }

    // The rest of the tabs, built ahead one to an idle while nothing is
    // moving: a grid is a couple of hundred actors, which is a dropped frame
    // on the click that first wants it.
    prebuild() {
        if (this._prebuildIdle)
            return;
        this._prebuildIdle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const next = this._sections.find(s => !this._pages.has(s.key));
            if (next)
                this._page(next.key).actor.hide();
            if (this._sections.some(s => !this._pages.has(s.key)))
                return GLib.SOURCE_CONTINUE;
            this._prebuildIdle = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // The slot under the grid, for a player bar (app.js), or null to clear
    // it. The grid's own budget shrinks by whatever height the footer takes,
    // so every page already built has to be built again against the new one.
    setFooter(actor = null) {
        if (actor === this._footer)
            return;
        if (this._footer)
            this.actor.remove_child(this._footer);
        this._footer = actor;
        if (actor)
            this.actor.add_child(actor);
        this._scheduleFooterRecheck();
    }

    // Both callers build this view, set the footer, and only then put the
    // view on the stage, and a footer measured off the stage has no theme to
    // answer with. So it is measured on the next idle, by which time the view
    // is on the stage; the first pages, built against no footer, are built
    // again against the real height.
    _scheduleFooterRecheck() {
        if (this._footerRecheckId)
            return;
        this._footerRecheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._footerRecheckId = 0;
            this._measureFooter();
            return GLib.SOURCE_REMOVE;
        });
    }

    _measureFooter() {
        if (!this.actor.get_stage())
            return;
        ensureStyleDeep(this.actor);
        const height = this._footer ? Math.max(0, this._footer.get_preferred_height(-1)[1]) : 0;
        // Nothing to redo if the number didn't move and pages already exist
        // against it — the common case once the recheck lands on a stable,
        // already-styled tree.
        if (height === this._footerHeight && this._pages.size)
            return;
        this._footerHeight = height;
        for (const page of this._pages.values())
            page.actor.destroy();
        this._pages.clear();
        if (this._key)
            this.show(this._key);
    }

    // Where the keyboard starts: the grid's first tile on show, or, with
    // nothing in the section, whatever the empty state offers.
    focusFirst() {
        const page = this._pages.get(this._key);
        if (page?.view?.focusFirst)
            return page.view.focusFirst();
        return page?.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false) ?? false;
    }

    _sectionFor(key) {
        return this._sections.find(s => s.key === key) ?? this._sections[0] ?? null;
    }

    // The button is held down while the sync it asked for runs.
    _sync(onSync) {
        const pending = onSync?.();
        if (!pending || !this._syncButton.reactive)
            return;
        this._syncButton.reactive = false;
        this._syncButton.opacity = 128;
        pending.finally(() => {
            this._syncButton.reactive = true;
            this._syncButton.opacity = 255;
        });
    }

    _page(key) {
        let page = this._pages.get(key);
        if (page)
            return page;
        const section = this._sections.find(s => s.key === key);
        const items = this._itemsFor(key);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = this._height - HEADER_ALLOWANCE * scale - this._footerHeight;
        let view = null;
        let actor;
        if (!items.length) {
            // A section with nothing in it says so, rather than showing an
            // empty grid or shelf.
            actor = createEmptyState({
                icon: section.icon,
                title: `No ${section.title.toLowerCase()} yet`,
                hint: section.emptyHint,
                actionLabel: this._onOpenSettings ? 'Open Settings' : null,
                onAction: this._onOpenSettings,
            });
        } else if (section.shelves) {
            // Listen Now: a vertical scroll of one-row grids. Given the same
            // box a grid gets (short of the footer already), so its tiles come
            // out the size a tab's do and its ScrollView ends above the bar
            // instead of filling the whole (unclipped) stack and running
            // behind it.
            const shelf = new ShelfView({
                section,
                shelves: items,
                width: this._width,
                height,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onContextMenu: this._onContextMenu,
            });
            view = shelf;
            actor = shelf.actor;
        } else {
            actor = view = createMediaView({
                section,
                items,
                width: this._width,
                height,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onContextMenu: this._onContextMenu,
            });
        }
        this.stack.add_child(actor);
        page = {actor, view};
        this._pages.set(key, page);
        return page;
    }

    // The two steps between the tabs and the grid under them that St's own
    // navigation cannot take (see the top of this file). Only while the grid
    // is what shows: an open item has the stack to itself, and the header's
    // Back button then leads down into that. A shelf has no top row of its
    // own to step up from, so it simply does not answer `atTopRow`.
    _onKeyPress(event) {
        const page = this._pages.get(this._key);
        if (!page?.actor.visible)
            return Clutter.EVENT_PROPAGATE;
        const view = page.view;
        const focus = global.stage.get_key_focus();
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Up && view?.atTopRow?.(focus))
            return this.header.focusTabs() ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (symbol === Clutter.KEY_Down && focus && this.header.actor.contains(focus) && view?.focusFirst)
            return view.focusFirst() ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_PROPAGATE;
    }
}
