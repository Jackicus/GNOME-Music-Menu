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
// `ProviderInfo.animateLaunch()` (extracted from GNOME 50's own
// libshell-*.so with objcopy + `Gio.Resource.load()` to check):
//
//     animateLaunch() {
//         const appSys = Shell.AppSystem.get_default();
//         const app = appSys.lookup_app(this.provider.appInfo.get_id());
//         if (app.state === Shell.AppState.STOPPED)
//             IconGrid.zoomOutActor(this._content);
//     }
//
// `lookup_app()` returns null for any id that names no installed app, and
// `app.state` on that null throws straight out of the button's `clicked`
// handler — GNOME 50 does not guard this. There is no hook a provider can
// use to make `animateLaunch()` skip itself, short of leaving `appInfo` off
// entirely (and losing the heading), so `get_id()` names a desktop file the
// shell itself ships wherever it runs: `org.gnome.Shell.Extensions.desktop`
// (the hidden launcher for an extension's preferences). It always resolves,
// so the click animates nothing and throws nothing.
//
// The engine is never started for a search: typing in the overview must not
// launch Chrome. Apple Music answers once it is running — the library's
// button starts it — and stays quiet otherwise.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {run} from './amctl.js';
import {notifyFailure} from './notify.js';
import {cacheRemoteArt} from './playerUtil.js';

const MIN_CHARS = 3;
const RESULT_LIMIT = 12;
const DEBOUNCE_MS = 250;

export class MusicSearchProvider {
    // `gicon` is the library's own icon, for the heading over the results.
    constructor({onActivate, gicon}) {
        this._onActivate = onActivate;
        this.id = 'apple-music';
        this.isRemoteProvider = false;
        // There is nowhere of ours to send "show more" to but Apple Music's
        // own web search, which launchSearch() below does.
        this.canLaunchSearch = true;
        this.appInfo = {
            get_name: () => 'Apple Music',
            get_icon: () => gicon ?? Gio.ThemedIcon.new('audio-x-generic-symbolic'),
            // See the file header: this has to be an id `Shell.AppSystem`
            // can actually resolve, or the provider heading's own click
            // handler throws.
            get_id: () => 'org.gnome.Shell.Extensions.desktop',
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
                run(['--no-start', 'search', query, '--limit', String(RESULT_LIMIT)], {cancellable})
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

    // A result's own icon, never blank and never blocking. `item.art` is
    // whatever `am.py search`'s normalizer put there:
    //  - a local path, if the hit is already in the synced library (or
    //    happens to share a synced item's artwork) — the file it names
    //    genuinely exists, so it can be used straight away;
    //  - a local path `sync.py` only *computed* (the cache location an
    //    eventual download would land at) for a catalog hit that has never
    //    been synced — the file it names does not exist yet, because
    //    `handle_search()` never downloads it, only `handle_sync()` does;
    //  - null, if the raw result carried no artwork at all;
    //  - (defensively) a plain https URL, should a future `am.py` ever pass
    //    the catalog artwork URL itself through instead of a precomputed
    //    cache path.
    // A symbolic icon shows immediately in every case; a real one — local or
    // freshly fetched — replaces it in place once it is known to exist.
    _createIcon(item, size) {
        const iconName = item.kind === 'artist' ? 'avatar-default-symbolic'
            : item.kind === 'album' ? 'media-optical-cd-audio-symbolic'
                : 'audio-x-generic-symbolic';
        const icon = new St.Icon({icon_name: iconName, icon_size: size});

        // Results are rebuilt on every keystroke, so an async load landing
        // after this row is gone must not touch the icon — there is no
        // `destroyed` property on a Clutter actor, so it is tracked by hand
        // (the same pattern `playerBar.js`/`player.js` use).
        let destroyed = false;
        icon.connect('destroy', () => (destroyed = true));

        const art = item.art;
        if (!art)
            return icon;

        if (art.startsWith('https://') || art.startsWith('http://'))
            this._loadRemoteArt(art, icon, () => destroyed);
        else
            this._loadLocalArt(art, icon, () => destroyed);

        return icon;
    }

    // `icon` already shows the symbolic fallback; this only ever upgrades it
    // (or silently leaves it be, e.g. on a missing file or a row that is
    // gone by the time the check finishes).
    _loadLocalArt(path, icon, isDestroyed) {
        const file = Gio.File.new_for_path(path);
        file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (source, res) => {
                try {
                    source.query_info_finish(res);
                } catch {
                    return; // never downloaded — keep the symbolic fallback
                }
                if (!isDestroyed())
                    icon.gicon = Gio.FileIcon.new(file);
            });
    }

    // Catalog artwork is fetched into the same cache the player's cover art
    // uses (playerUtil.js), so a repeat search shows the icon at once.
    _loadRemoteArt(url, icon, isDestroyed) {
        cacheRemoteArt(url).then(path => {
            if (path && !isDestroyed())
                icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
        });
    }

    activateResult(id) {
        const item = this._items.get(id);
        if (!item)
            return;
        if (item.kind === 'song')
            run(['play', 'song', id]).catch(notifyFailure);
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
