// Apple Music in the overview's own search, sitting beside "Applications"
// and every other provider. This is an in-process provider (`isRemoteProvider
// = false`): it lives in the shell's own address space rather than behind a
// D-Bus search interface, which is the only way an extension can register one
// — `remoteSearch.js` only ever loads providers from other apps' `.desktop`
// files.
//
// Giving the provider an `appInfo` (name + icon) is what earns it the
// labelled "Apple Music" row search.js draws above its results
// (search.js's `_ensureProviderDisplay`: a provider with an `appInfo` gets a
// `ListSearchResults`, with a `ProviderInfo` header built from exactly
// `get_name()` and `get_icon()`; without one it gets a bare `GridSearchResults`
// the way the built-in app search does). One caveat that comes with it: that
// header is itself a button, and clicking it calls the shell's own
// `ProviderInfo.animateLaunch()`, which looks our `appInfo.get_id()` up in
// `Shell.AppSystem` — an id that names no installed app, since this isn't
// one. On stock GNOME 50 that lookup returns null and the click logs a
// harmless JS error to the journal instead of animating; it does not throw
// past the signal handler or affect the shell otherwise. There is no hook a
// provider can use to avoid it, short of leaving `appInfo` off (and losing
// the heading), so it's left as a known rough edge.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {run} from './amctl.js';

const MIN_CHARS = 3;
const RESULT_LIMIT = 12;
const DEBOUNCE_MS = 250;

export class MusicSearchProvider {
    constructor({onActivate}) {
        this._onActivate = onActivate;
        this.id = 'apple-music';
        this.isRemoteProvider = false;
        // There is nowhere of ours to send "show more" to but Apple Music's
        // own web search, which launchSearch() below does.
        this.canLaunchSearch = true;
        this.appInfo = {
            get_name: () => 'Apple Music',
            get_icon: () => Gio.ThemedIcon.new('audio-x-generic-symbolic'),
            get_id: () => 'music-menu-search-provider',
            // Read by ParentalControlsManager.shouldShowApp() before this
            // provider is even registered; true is "don't hide me".
            should_show: () => true,
        };

        // Every id this session's searches have turned up, so a result can
        // be turned back into an Item when the shell asks for its meta or
        // activates it.
        this._items = new Map();
        this._debounceId = 0;
    }

    register() {
        Main.overview.searchController.addProvider(this);
    }

    unregister() {
        Main.overview.searchController.removeProvider(this);
        this._cancelDebounce();
    }

    _cancelDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    // One `am.py search` per burst of keystrokes, not one per letter: a
    // pending call is dropped in favour of the newest terms, and cancelling
    // (the search superseded, or the overview closing) resolves to no
    // results instead of rejecting, so nothing gets logged as a provider
    // error over what is just a keystroke arriving late.
    _search(terms, cancellable) {
        const query = terms.join(' ').trim();
        if (query.length < MIN_CHARS)
            return Promise.resolve([]);

        this._cancelDebounce();
        return new Promise(resolve => {
            const cancelId = cancellable.connect(() => {
                this._cancelDebounce();
                resolve([]);
            });
            this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                this._debounceId = 0;
                cancellable.disconnect(cancelId);
                if (cancellable.is_cancelled()) {
                    resolve([]);
                    return GLib.SOURCE_REMOVE;
                }
                run(['search', query, '--limit', String(RESULT_LIMIT)], {cancellable})
                    .then(({items = []}) => {
                        const ids = [];
                        for (const item of items) {
                            this._items.set(item.id, item);
                            ids.push(item.id);
                        }
                        resolve(ids);
                    })
                    .catch(() => resolve([]));
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    getInitialResultSet(terms, cancellable) {
        return this._search(terms, cancellable);
    }

    getSubsearchResultSet(previousResults, terms, cancellable) {
        // Nothing here narrows the previous results faster than a fresh
        // search: `am.py search` takes the whole term every time.
        return this._search(terms, cancellable);
    }

    filterResults(results, max) {
        return results.slice(0, max);
    }

    getResultMetas(ids) {
        const metas = ids.map(id => {
            const item = this._items.get(id);
            if (!item)
                return {id, name: id, description: '', createIcon: () => null};
            return {
                id,
                name: item.title,
                description: item.subtitle ?? '',
                createIcon: size => this._createIcon(item, size),
            };
        });
        return Promise.resolve(metas);
    }

    _createIcon(item, size) {
        if (item.art) {
            return new St.Icon({
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(item.art)),
                icon_size: size,
            });
        }
        const iconName = item.kind === 'artist'
            ? 'avatar-default-symbolic'
            : 'audio-x-generic-symbolic';
        return new St.Icon({icon_name: iconName, icon_size: size});
    }

    activateResult(id) {
        const item = this._items.get(id);
        if (!item)
            return;
        if (item.kind === 'song')
            run(['play', 'song', id]).catch(() => {});
        else
            this._onActivate(item);
    }

    // The provider heading's own "N more" click: there is no fuller results
    // view of ours to open, so this goes straight to Apple Music's own
    // search on the web.
    launchSearch(terms) {
        const uri = `https://music.apple.com/search?term=${encodeURIComponent(terms.join(' '))}`;
        Gio.AppInfo.launch_default_for_uri(uri, null);
    }
}
