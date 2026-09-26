// Apple Music in the overview's own search, sitting beside "Applications"
// and every other provider. These are in-process providers
// (`isRemoteProvider = false`): they live in the shell's own address space
// rather than behind a D-Bus search interface, which is the only way an
// extension can register one — `remoteSearch.js` only ever loads providers
// from other apps' `.desktop` files.
//
// Two searches live here. Among every provider on the system — the
// window picker's, the app grid's — Apple Music is one section, "Apple
// Music", a list of its best few hits of every kind. With the library up
// in the overview a search is Apple Music's alone (mediaMenu.js holds
// `exclusive` for as long as one is, and keeps the system's providers out
// of it), and then it is laid out as Apple Music's own search box lays its
// own out, one provider — one section of the shell's results — for each
// part of it: Top Results as a row of five icons, the way the shell shows
// the apps it finds; then Apple's own completions of what is half typed,
// each a search of its own to pick; then a list per kind — Artists,
// Albums, Songs, Playlists, Music Videos, Stations — under its own name.
// A search that is Apple Music's alone is answered from its first letter,
// where a search among every provider waits for a third; and where the
// engine cannot answer it — down, or not signed in — the "Apple Music"
// section says so in a row of its own, which picked puts it right.
//
// One `am.py search` serves every section: search.js's `_doSearch` puts a
// search to each provider in turn, in the same round, so the first to ask
// starts the pause after the keystroke and all of them get the one answer
// (`Shared`) — the completions too, which the same call asks Apple for
// alongside the search (`--suggest`), so a pause in typing is one process
// and not two. It never starts the engine (`--no-start`): typing in the
// overview must not launch Chrome.
//
// Giving a provider an `appInfo` (name + icon) is what earns it the
// labelled row search.js draws above its results (`_ensureProviderDisplay`:
// a provider with an `appInfo` gets a `ListSearchResults`, with a
// `ProviderInfo` header built from exactly `get_name()` and `get_icon()`;
// without one it gets a bare `GridSearchResults` the way the built-in app
// search does — which is what Top Results wants). One caveat that comes
// with a header: it is itself a button, and clicking it calls the shell's
// own `ProviderInfo.animateLaunch()`:
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
// A pick from any section is remembered (recents.js) for the search page's
// "Recently Searched".

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';

import {run} from './amctl.js';
import {SIGN_IN_HINT} from './library.js';
import {notifyFailure} from './notify.js';
import {cacheRemoteArt} from './playerUtil.js';

// Among every provider, nothing before the third letter: a letter or two
// is anyone's, and a search is a process and a round trip to Chrome.
const MIN_CHARS = 3;
// The pause after the last keystroke before a search goes out. On top of
// the shell's own: search.js waits 150ms after the first keystroke of a
// burst before it asks anyone, so this is the trailing part alone.
const DEBOUNCE_MS = 100;
// Hits asked for: the one list among every provider; per kind, for the
// sections of a search that is Apple Music's alone.
const RESULT_LIMIT = 12;
const PER_KIND = 10;
// The icon row, as long as the shell's own row of apps.
const TOP_RESULTS = 5;
const SUGGESTIONS = 3;

// The sections of a search that is Apple Music's alone, after the icon
// row, in the order they stand. `key` is the shelf `am.py search` answers
// with; the completions are `am.py suggest`'s.
const SECTIONS = [
    {key: 'suggest', title: 'Suggestions', icon: 'edit-find-symbolic'},
    {key: 'artists', title: 'Artists', icon: 'avatar-default-symbolic'},
    {key: 'albums', title: 'Albums', icon: 'media-optical-cd-audio-symbolic'},
    {key: 'songs', title: 'Songs', icon: 'audio-x-generic-symbolic'},
    {key: 'playlists', title: 'Playlists', icon: 'view-list-symbolic'},
    {key: 'music-videos', title: 'Music Videos', icon: 'video-x-generic-symbolic'},
    {key: 'stations', title: 'Stations', icon: 'radio-symbolic'},
];

// What stands in for a hit's cover until that is on disk.
const KIND_ICON = {
    artist: 'avatar-default-symbolic',
    album: 'media-optical-cd-audio-symbolic',
    playlist: 'view-list-symbolic',
    station: 'radio-symbolic',
    video: 'video-x-generic-symbolic',
    song: 'audio-x-generic-symbolic',
};

// The rows the "Apple Music" section answers a search of Apple Music's
// alone with when the engine cannot, by the error `am.py` gives, under
// ids no item has.
const STATUS_PREFIX = 'music-menu:';
const STATUS = {
    'engine-down': {
        name: 'Apple Music is not running',
        description: 'Choose this to start it, or press Sync in the library',
        icon: 'network-offline-symbolic',
    },
    'not-signed-in': {
        name: 'Not signed in',
        description: SIGN_IN_HINT,
        icon: 'avatar-default-symbolic',
    },
};
const SUGGEST_PREFIX = 'suggest:';

function statusCode(id) {
    return id.startsWith(STATUS_PREFIX) ? id.slice(STATUS_PREFIX.length) : null;
}

function itemKey(item) {
    return `${item.kind}:${item.id}`;
}

// One `am.py` call per pause in typing, shared by everyone who asks for
// the same command: a pending call is dropped in favour of a newer one,
// and cancelling (the search superseded, or the overview closing) resolves
// to nothing instead of rejecting, so nothing gets logged as a provider
// error over what is just a keystroke arriving late. An answer is kept
// for as long as its command stands, so a section asking a moment after
// another gets it at once. A failure answers `{error}` with `am.py`'s
// code, for the one section that says so.
class Shared {
    constructor() {
        this._key = null;
        this._promise = null;
        this._timer = 0;
    }

    ask(argv, cancellable) {
        const key = argv.join('\n');
        if (this._promise && this._key === key)
            return this._promise;
        this._drop();
        this._key = key;
        this._promise = new Promise(resolve => {
            const cancelId = cancellable.connect(() => {
                if (this._key === key)
                    this._drop();
                resolve(null);
            });
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                this._timer = 0;
                if (cancellable.is_cancelled()) {
                    resolve(null);
                    return GLib.SOURCE_REMOVE;
                }
                run(argv, {cancellable})
                    .then(answer => resolve(answer), e => resolve({error: e?.code ?? 'error'}))
                    .finally(() => cancellable.disconnect(cancelId));
                return GLib.SOURCE_REMOVE;
            });
        });
        return this._promise;
    }

    drop() {
        this._drop();
    }

    _drop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._key = null;
        this._promise = null;
    }
}

// One provider, as search.js wants it; every answer comes from the search
// it belongs to. `key` is the shelf of `am.py search`'s answer it shows;
// `section` is null for the "Apple Music" list and for the icon row, and
// with one, the heading over the list is its.
class Provider {
    constructor(search, {id, key = null, section = null, gicon = null, maxResults = -1, canLaunchSearch = false}) {
        this._search = search;
        this.id = id;
        this.key = key ?? section?.key ?? id;
        this.isRemoteProvider = false;
        this.canLaunchSearch = canLaunchSearch;
        if (gicon || section) {
            this.appInfo = {
                get_name: () => section?.title ?? 'Apple Music',
                get_icon: () => section ? Gio.ThemedIcon.new(section.icon) : gicon,
                // See the file header: this has to be an id `Shell.AppSystem`
                // can actually resolve, or the heading's own click handler
                // throws.
                get_id: () => 'org.gnome.Shell.Extensions.desktop',
                // Read by ParentalControlsManager.shouldShowApp() before this
                // provider is even registered; true is "don't hide me".
                should_show: () => true,
            };
        }
        // Read by the shell's grid display: how many icons at most.
        if (maxResults > 0)
            this.maxResults = maxResults;
    }

    getInitialResultSet(terms, cancellable) {
        return this._search.answer(this, terms, cancellable);
    }

    getSubsearchResultSet(previousResults, terms, cancellable) {
        // Nothing here narrows the previous results faster than a fresh
        // search: `am.py search` takes the whole term every time.
        return this._search.answer(this, terms, cancellable);
    }

    filterResults(results, max) {
        return results.slice(0, max);
    }

    getResultMetas(ids) {
        return Promise.resolve(ids.map(id => this._search.metaFor(id)));
    }

    activateResult(id) {
        this._search.activate(id);
    }

    // The heading's own "N more" click: there is no fuller results view of
    // ours to open, so this goes straight to Apple Music's own search on
    // the web.
    launchSearch(terms) {
        const uri = `https://music.apple.com/search?term=${encodeURIComponent(terms.join(' '))}`;
        Gio.AppInfo.launch_default_for_uri(uri, null);
    }
}

// The completions' rows: the shell's own list row, but picked it is the
// next search rather than a result, so it must not take the overview
// down as the shell's `SearchResult.activate()` does.
class SuggestionProvider extends Provider {
    createResultObject(meta) {
        // The results view a row wants for its terms and their
        // highlighting; the shell hands the display no more than the meta.
        const results = Main.overview.searchController?._searchResults ?? null;
        const row = new Search.ListSearchResult(this, meta, results);
        row.activate = () => this.activateResult(meta.id);
        return row;
    }
}

export class MusicSearch {
    // `gicon` is the library's own icon, for the heading over the "Apple
    // Music" list; `onActivate(item)` is a hit picked, `onOpenSettings`
    // where the not-signed-in row goes; `recents` (recents.js) remembers
    // the picks.
    constructor({onActivate, onOpenSettings = null, gicon, recents = null}) {
        this._onActivate = onActivate;
        this._onOpenSettings = onOpenSettings;
        this._recents = recents;
        // Whether the search up is Apple Music's alone (see the file header).
        this.exclusive = false;
        // Every hit this session's searches have turned up, by kind and id,
        // so a result can be turned back into an Item when the shell asks
        // for its meta or activates it.
        this._items = new Map();
        this._searches = new Shared();

        this._shared = new Provider(this, {id: 'apple-music', gicon, canLaunchSearch: true});
        this._top = new Provider(this, {id: 'apple-music-top', key: 'top', maxResults: TOP_RESULTS});
        this._sections = SECTIONS.map(section => section.key === 'suggest'
            ? new SuggestionProvider(this, {id: 'apple-music-suggest', section})
            : new Provider(this, {id: `apple-music-${section.key}`, section, canLaunchSearch: true}));
        // In the order the shell shows them.
        this._providers = [this._shared, this._top, ...this._sections];
    }

    register() {
        for (const provider of this._providers)
            Main.overview.searchController.addProvider(provider);
    }

    unregister() {
        for (const provider of this._providers)
            Main.overview.searchController.removeProvider(provider);
        this._searches.drop();
    }

    // Whether `provider` is one of these — for mediaMenu.js, which keeps
    // every other out of a search that is Apple Music's alone.
    owns(provider) {
        return this._providers.includes(provider);
    }

    // A provider's answer to `terms`: result ids, or a status row's.
    // Whether the search is Apple Music's alone is taken as it is asked,
    // before the pause — and decides the one command every section of that
    // round shares: with the completions, for a search that is Apple
    // Music's alone, and without them among every provider, where no
    // section shows them.
    answer(provider, terms, cancellable) {
        const query = terms.join(' ').trim();
        const exclusive = this.exclusive;
        if (provider === this._shared) {
            if (exclusive)
                return this._askSearch(query, exclusive, cancellable, answer => answer?.error && STATUS[answer.error] ? [STATUS_PREFIX + answer.error] : []);
            if (query.length < MIN_CHARS)
                return Promise.resolve([]);
            return this._askSearch(query, exclusive, cancellable, answer => this._register(answer?.items).slice(0, RESULT_LIMIT));
        }
        if (!exclusive || !query)
            return Promise.resolve([]);
        if (provider.key === 'suggest') {
            return this._askSearch(query, exclusive, cancellable, answer => {
                const terms = Array.isArray(answer?.terms) ? answer.terms : [];
                return terms.slice(0, SUGGESTIONS).map(({term}) => SUGGEST_PREFIX + term);
            });
        }
        return this._askSearch(query, exclusive, cancellable, answer => {
            const shelf = answer?.shelves?.find(s => s.key === provider.key);
            const ids = this._register(shelf?.items);
            return provider === this._top ? ids.slice(0, TOP_RESULTS) : ids;
        });
    }

    _askSearch(query, exclusive, cancellable, take) {
        if (!query)
            return Promise.resolve([]);
        const argv = ['--no-start', 'search', query, '--limit', String(PER_KIND)];
        if (exclusive)
            argv.push('--suggest', String(SUGGESTIONS));
        return this._searches.ask(argv, cancellable).then(answer => answer ? take(answer) : []);
    }

    // The hits kept, and their ids in order.
    _register(items) {
        const ids = [];
        for (const item of Array.isArray(items) ? items : []) {
            if (!item?.id || !item.kind)
                continue;
            const key = itemKey(item);
            this._items.set(key, item);
            ids.push(key);
        }
        return ids;
    }

    metaFor(id) {
        const status = STATUS[statusCode(id) ?? ''];
        if (status) {
            return {
                id,
                name: status.name,
                description: status.description,
                createIcon: size => new St.Icon({icon_name: status.icon, icon_size: size}),
            };
        }
        if (id.startsWith(SUGGEST_PREFIX)) {
            return {
                id,
                name: id.slice(SUGGEST_PREFIX.length),
                description: '',
                createIcon: size => new St.Icon({icon_name: 'edit-find-symbolic', icon_size: size}),
            };
        }
        const item = this._items.get(id);
        if (!item)
            return {id, name: id, description: '', createIcon: () => null};
        return {
            id,
            name: item.title,
            description: item.subtitle ?? '',
            createIcon: size => createArtIcon(item, size),
        };
    }

    activate(id) {
        const code = statusCode(id);
        if (code === 'engine-down') {
            run(['engine', 'start']).catch(notifyFailure);
            return;
        }
        if (code === 'not-signed-in') {
            this._onOpenSettings?.();
            return;
        }
        if (id.startsWith(SUGGEST_PREFIX)) {
            this._searchFor(id.slice(SUGGEST_PREFIX.length));
            return;
        }
        const item = this._items.get(id);
        if (!item)
            return;
        this._recents?.add(item);
        this._onActivate(item);
    }

    // A completion picked: the entry's text, which is the next search, with
    // the keyboard back in the entry at the end of it.
    _searchFor(term) {
        const entry = Main.overview.searchEntry;
        if (!entry)
            return;
        entry.text = term;
        const text = entry.clutter_text;
        text.grab_key_focus();
        text.set_cursor_position(-1);
        text.set_selection(-1, -1);
    }
}

// A hit's picture, never blank and never blocking: a symbolic stand-in at
// once, and its cover over it as soon as that is known to be on disk or
// has been fetched. `item.art` is whatever `am.py search`'s normalizer put
// there — a local path (the sync's, which may or may not exist yet), a
// small catalog URL, or null; `item.thumb` only ever names a file on disk.
// Catalog artwork is fetched into the same cache the player's cover art
// uses (playerUtil.js), so a repeat search shows it at once. Results are
// rebuilt on every keystroke, so a load landing after its row is gone must
// not touch it — there is no `destroyed` property on a Clutter actor, so it
// is tracked by hand (the same pattern playerBar.js and player.js use).
export function createArtIcon(item, size) {
    // `size` is logical, as the shell hands it to `createIcon`; an actor's
    // own size is in stage pixels.
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const bin = new St.Bin({
        style_class: 'mm-search-art',
        width: Math.round(size * scale),
        height: Math.round(size * scale),
        x_expand: false,
        y_expand: false,
    });
    bin.child = new St.Icon({
        icon_name: KIND_ICON[item.kind] ?? 'audio-x-generic-symbolic',
        icon_size: Math.max(16, Math.round(size * 0.6)),
    });
    const radius = item.kind === 'artist' ? Math.ceil(size / 2) : Math.max(4, Math.round(size * 0.16));
    bin.set_style(`border-radius: ${radius}px;`);

    let destroyed = false;
    bin.connect('destroy', () => (destroyed = true));
    const show = path => {
        if (destroyed || !path)
            return;
        bin.child = null;
        bin.set_style(`background-image: url("file://${encodeURI(path)}"); background-size: cover; border-radius: ${radius}px;`);
    };
    resolveArt(item).then(show);
    return bin;
}

// The file a hit's cover is in, or null: its thumbnail if on disk, its
// cover if that is, or the catalog's copy fetched.
function resolveArt(item) {
    const candidates = [item.thumb, item.art].filter(path => typeof path === 'string' && path);
    const next = () => {
        const path = candidates.shift();
        if (!path)
            return Promise.resolve(null);
        if (path.startsWith('https://') || path.startsWith('http://'))
            return cacheRemoteArt(path);
        return fileExists(path).then(exists => exists ? path : next());
    };
    return next();
}

function fileExists(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (source, res) => {
                try {
                    source.query_info_finish(res);
                    resolve(true);
                } catch {
                    resolve(false);
                }
            });
    });
}
