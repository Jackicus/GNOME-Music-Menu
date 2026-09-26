// Apple Music's search, in the library. While the library is up in the
// overview, the shell's own "Type to search" entry asks Apple Music and
// nothing else (mediaMenu.js keeps the shell's providers out of it and hands
// the entry's text here), and what comes back is laid out as music.apple.com
// lays its own search page out: a shelf of Top Results, then a shelf per
// kind — Artists, Albums, Songs, Playlists, Stations — each one row of the
// very tiles every other tab shows (shelfView.js), so they page, focus and
// open the same way.
//
// One `am.py search` per pause in typing, never one per letter, and never
// one that starts the engine (`--no-start`): typing in the overview must not
// launch Chrome. The answer to an older question is dropped once a newer one
// has been asked, and between answers the last results stand, as Apple
// Music's do, rather than the page blinking empty on every letter.
//
// A catalog hit's artwork is not in the cache — a search never waits on
// downloads (backend/README.md) — so a tile starts on the drawn placeholder
// and takes its cover as the small catalog copy lands, a few fetches at a
// time; the cover the sync has already fetched shows outright.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {run} from './amctl.js';
import {SIGN_IN_HINT, sectionKeyForKind} from './library.js';
import {ShelfView} from './shelfView.js';
import {createEmptyState} from './widgets.js';
import {cacheRemoteArt} from './playerUtil.js';

// The pause after the last keystroke before a search goes out.
const DEBOUNCE_MS = 250;
// Hits asked for per kind: a row of tiles and a little more behind "See All".
const PER_KIND = 10;
// Covers fetched at once. A page of hits is fifty of them, and the shell's
// main loop takes each one's arrival.
const FETCHES_AT_ONCE = 4;

// The tiles' section: every shelf holds hits of mixed kinds, so the tile
// says what each is — the icon, the round artist lockup — as a Listen Now
// shelf's do (`shelves: true`, mediaGrid.js MediaItem).
const SECTION = {key: 'search', title: 'Search', icon: 'edit-find-symbolic', aspect: 1.0, shelves: true};

export class SearchView {
    // `width` and `height` are the page's budget, in physical px, the same a
    // tab's grid gets; `onActivate(key, item, tile)` and `onContextMenu` are
    // the library's own, with `key` the tab a hit's kind belongs with.
    constructor({width, height, columns, rows, onActivate, onContextMenu, onOpenSettings}) {
        this._box = {width, height, columns, rows};
        this._onActivate = onActivate;
        this._onContextMenu = onContextMenu;
        this._onOpenSettings = onOpenSettings;
        // What is being looked for, and what the shelves on show answer.
        this._query = '';
        this._shown = '';
        this._timer = 0;
        // The search out, and the cover fetches for the results on show.
        this._cancellable = null;
        this._fetching = null;
        // The shelves, or the state (searching, nothing found, engine down).
        this._shelves = null;
        this._state = null;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.actor.connect('destroy', () => this._stop());
    }

    destroy() {
        this.actor.destroy();
    }

    get query() {
        return this._query;
    }

    // The entry's text, at every keystroke. Empty is the end of the search.
    setQuery(text) {
        const query = (text ?? '').trim();
        if (query === this._query)
            return;
        this._query = query;
        this._stop();
        if (!query) {
            this._clear();
            return;
        }
        // Only when nothing answers yet: the last results stand until the
        // next arrive.
        if (!this._shelves)
            this._say({icon: 'edit-find-symbolic', title: 'Searching…', hint: `Apple Music, for “${query}”`});
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._timer = 0;
            this._search(query);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _search(query) {
        const cancellable = this._cancellable = new Gio.Cancellable();
        let answer;
        try {
            answer = await run(['--no-start', 'search', query, '--limit', String(PER_KIND)], {cancellable});
        } catch (e) {
            if (cancellable.is_cancelled() || query !== this._query)
                return;
            this._cancellable = null;
            this._fail(e, query);
            return;
        }
        if (cancellable.is_cancelled() || query !== this._query)
            return;
        this._cancellable = null;
        this._show(query, Array.isArray(answer?.shelves) ? answer.shelves : []);
    }

    // The search's own reasons for nothing to show, said as the empty tabs
    // say theirs. The engine is never started for a search, so its being
    // down is the usual one.
    _fail(error, query) {
        this._dropShelves();
        if (error?.code === 'engine-down') {
            this._say({
                icon: 'network-offline-symbolic',
                title: 'Apple Music is not running',
                hint: 'Press Sync to start it, or turn on “Start engine automatically” in Settings.',
                actionLabel: this._onOpenSettings ? 'Open Settings' : null,
                onAction: this._onOpenSettings,
            });
        } else if (error?.code === 'not-signed-in') {
            this._say({icon: 'avatar-default-symbolic', title: 'Not signed in', hint: SIGN_IN_HINT});
        } else {
            this._say({icon: 'dialog-warning-symbolic', title: `Could not search for “${query}”`, hint: error?.message ?? ''});
        }
    }

    _show(query, shelves) {
        this._dropShelves();
        this._dropState();
        this._shown = query;
        const rows = shelves.filter(shelf => shelf.items?.length);
        if (!rows.length) {
            this._say({icon: 'edit-find-symbolic', title: `No results for “${query}”`, hint: 'Try another name, title or lyric.'});
            return;
        }
        // A hit's `art` is a catalog URL when the sync has not fetched it —
        // nothing a background-image can draw, and not what the hero wants
        // either: kept aside for the fetch below, and the pane takes the
        // real cover when `am.py item` fills the hit in (app.js).
        const unfetched = [];
        for (const shelf of rows) {
            for (const item of shelf.items) {
                if (typeof item.art === 'string' && /^https?:\/\//.test(item.art)) {
                    item.artUrl = item.art;
                    item.art = null;
                    if (!item.thumb)
                        unfetched.push(item);
                }
            }
        }
        const {width, height, columns, rows: gridRows} = this._box;
        this._shelves = new ShelfView({
            section: SECTION,
            shelves: rows,
            width,
            height,
            columns,
            rows: gridRows,
            onActivate: (_key, item, tile) => this._onActivate(sectionKeyForKind(item.kind), item, tile),
            onContextMenu: this._onContextMenu,
        });
        this.actor.add_child(this._shelves.actor);
        this._fetchCovers(unfetched);
    }

    // The covers the sync has not got, a few at a time, each onto its tile
    // as it lands — or onto the item alone, for a tile on a shelf not built
    // yet, which draws it when it is. Cancelled with the results they are
    // for, so a late one never touches a tile that has gone.
    _fetchCovers(items) {
        const cancellable = this._fetching = new Gio.Cancellable();
        const queue = [...items];
        const next = () => {
            const item = queue.shift();
            if (!item || cancellable.is_cancelled())
                return;
            cacheRemoteArt(item.artUrl, cancellable).then(path => {
                if (cancellable.is_cancelled())
                    return;
                if (path) {
                    item.thumb = path;
                    // A BaseIcon builds its picture again from what its
                    // item says now.
                    this._shelves?.tileFor(item.id)?.icon.update();
                }
                next();
            });
        };
        for (let i = 0; i < FETCHES_AT_ONCE; i++)
            next();
    }

    _say({icon, title, hint, actionLabel = null, onAction = null}) {
        this._dropState();
        this._state = createEmptyState({icon, title, hint, actionLabel, onAction});
        this.actor.add_child(this._state);
    }

    _dropState() {
        this._state?.destroy();
        this._state = null;
    }

    _dropShelves() {
        this._fetching?.cancel();
        this._fetching = null;
        this._shelves?.destroy();
        this._shelves = null;
        this._shown = '';
    }

    // Whatever is out, called back.
    _stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _clear() {
        this._dropShelves();
        this._dropState();
    }

    // ------------------------------------------------------------------
    // What the library asks of the page on show, as it asks a grid or a
    // shelf: where the keyboard starts, whether it is on the top row, a
    // page on or back, and the tile an item is on.
    // ------------------------------------------------------------------
    focusFirst() {
        return this._shelves?.focusFirst() ?? false;
    }

    atTopRow(actor) {
        return this._shelves?.atTopRow(actor) ?? false;
    }

    pageBy(delta) {
        return this._shelves?.pageBy(delta) ?? false;
    }

    tileFor(itemId) {
        return this._shelves?.tileFor(itemId) ?? null;
    }

    // Enter in the entry: the top result, as the shell's own search takes
    // its first. With a search still out, nothing — the answer is not there
    // to take.
    activateFirst() {
        return this._shelves?.activateFirst() ?? false;
    }
}
