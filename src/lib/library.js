// Reads ~/.cache/music-menu/library.json (written by backend/am.py sync) and
// hands it to the views as it comes off disk: the Item and shelf shapes are
// am.py's own — see backend/README.md. The read is asynchronous, so a sync
// landing never stalls the compositor, and each read carries a stamp of the
// file's content so a sync that changed nothing is not a rebuild. Whether an
// item's artwork is actually on disk is not settled here but by the tile
// that draws it (widgets.js createArtwork), when it is built.
//
// Also here: the on-disk copy of an item fetched on demand (`am.py item`
// writes `<cache>/items/`), read back so a second look — in another
// session too — opens without a spawn.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');

export const SIGN_IN_HINT = 'Sign in to Apple Music in Settings, then press Sync.';

export const SECTIONS = [
    {
        key: 'listen-now',
        prefix: 'listen-now',
        title: 'Listen Now',
        icon: 'starred-symbolic',
        aspect: 1.0,
        // No grid of its own: a vertical list of shelves instead (shelfView.js).
        shelves: true,
        emptyHint: SIGN_IN_HINT,
    },
    {
        key: 'albums',
        prefix: 'albums',
        title: 'Albums',
        icon: 'media-optical-cd-audio-symbolic',
        aspect: 1.0,
        emptyHint: SIGN_IN_HINT,
    },
    {
        key: 'artists',
        prefix: 'artists',
        title: 'Artists',
        icon: 'avatar-default-symbolic',
        aspect: 1.0,
        // A round lockup rather than a square one (shape.js, mediaGrid.js).
        round: true,
        emptyHint: SIGN_IN_HINT,
    },
    {
        key: 'playlists',
        prefix: 'playlists',
        title: 'Playlists',
        icon: 'view-list-symbolic',
        aspect: 1.0,
        emptyHint: SIGN_IN_HINT,
    },
    {
        key: 'radio',
        prefix: 'radio',
        title: 'Radio',
        icon: 'radio-symbolic',
        aspect: 1.0,
        emptyHint: SIGN_IN_HINT,
    },
];

// The library as a whole: what its one button beside Show Apps is called and
// shows. The sections are its tabs. The icon is a file of the extension's
// own, in `icons/`, and is `-symbolic`, so St recolours it to the theme's
// foreground as it does the shell's own.
export const LIBRARY = {
    title: 'Music',
    icon: 'icons/library-symbolic.svg',
};

export function sectionByKey(key) {
    return SECTIONS.find(s => s.key === key) ?? SECTIONS[0];
}

// The section an item of `kind` belongs with, for the tab its detail is
// shown against when it was not picked from a tab — a search hit, a shelf's.
// A song has no tab of its own; its detail opens as an album's would.
const KIND_TO_SECTION = {
    album: 'albums', artist: 'artists', playlist: 'playlists', station: 'radio', song: 'albums',
};

export function sectionKeyForKind(kind) {
    return KIND_TO_SECTION[kind] ?? 'albums';
}

// Which sections are switched on, in SECTIONS' own order — read by app.js to
// decide which tabs and grids to build, and by prefs.js for the toggles.
export function enabledSections(settings) {
    return SECTIONS.filter(section => settings.get_boolean(`${section.prefix}-enabled`));
}

export function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-menu']);
}

export function libraryPath() {
    return GLib.build_filenamev([cacheDir(), 'library.json']);
}

// The file as am.py wrote it, read off the main loop: the raw per-section
// arrays, the shelves, when it last ran, and a stamp of the content with
// `generated` left out — two syncs that found the same library give the
// same stamp, whatever the clock said. A missing or unreadable file is an
// empty library with a stamp of null.
async function readLibraryFile() {
    const nothing = {sections: {}, shelves: [], generated: null, stamp: null};
    const file = Gio.File.new_for_path(libraryPath());
    let bytes;
    try {
        [bytes] = await file.load_bytes_async(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(`[Music Menu] Failed to read ${file.get_path()}: ${e.message}`);
        return nothing;
    }
    try {
        const text = new TextDecoder('utf-8').decode(bytes.get_data());
        const raw = JSON.parse(text);
        return {
            sections: raw?.sections ?? {},
            shelves: Array.isArray(raw?.shelves) ? raw.shelves : [],
            generated: raw?.generated ?? null,
            stamp: contentStamp(text),
        };
    } catch (e) {
        console.error(`[Music Menu] Failed to read ${file.get_path()}: ${e.message}`);
        return nothing;
    }
}

export function contentStamp(text) {
    const settled = text.replace(/"generated":\s*"[^"]*"/, '"generated": ""');
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, settled, -1);
}

// {albums: [Item], artists: [Item], playlists: [Item], radio: [Item],
// 'listen-now': [], shelves: [{key, title, items: [Item]}], stamp}. Listen
// Now has no grid of its own — only its shelves, which shelfView.js renders
// — so its key is always the empty array. Missing or unreadable files yield
// empty sections, never fake data.
export async function loadLibrary() {
    const {sections, shelves, stamp} = await readLibraryFile();
    const out = emptyLibrary();
    for (const section of SECTIONS) {
        if (section.shelves)
            continue;
        const items = sections[section.key];
        if (Array.isArray(items))
            out[section.key] = items.map(normalize).filter(Boolean);
    }
    out.shelves = shelves.map(shelf => ({
        key: shelf.key,
        title: shelf.title,
        items: Array.isArray(shelf.items) ? shelf.items.map(normalize).filter(Boolean) : [],
    }));
    out.stamp = stamp;
    return out;
}

// What stands in for the library before it has been read.
export function emptyLibrary() {
    const out = Object.fromEntries(SECTIONS.map(section => [section.key, []]));
    out.shelves = [];
    out.stamp = undefined;
    return out;
}

function normalize(item) {
    if (!item || !item.title)
        return null;
    return {
        id: item.id ?? item.title,
        kind: item.kind ?? null,
        title: item.title,
        subtitle: item.subtitle ?? null,
        year: item.year ?? null,
        genre: item.genre ?? null,
        summary: item.summary ?? null,
        art: item.art ?? null,
        thumb: item.thumb ?? null,
        artColor: item.artColor ?? null,
        countLabel: item.countLabel ?? null,
        explicit: !!item.explicit,
        catalogId: item.catalogId ?? null,
        url: item.url ?? null,
        play: item.play ?? null,
        groups: Array.isArray(item.groups) ? item.groups : [],
    };
}

// ---------------------------------------------------------------------------
// An item fetched on demand, as am.py left it on disk
//
// library.json carries a track list for what is in the library and only a
// tile for what a shelf or a search offers; `am.py item` fills the rest in,
// and writes what it fetched to <cache>/items/<kind>-<id>.json with the time
// it did. Read back here before the engine is asked, so the pane opens on
// it at once. An album's list never changes; a playlist's or an artist's
// does, and is asked for again after a day.
// ---------------------------------------------------------------------------
const ITEM_MAX_AGE = {playlist: 24 * 3600, artist: 24 * 3600};
const ITEM_DEFAULT_MAX_AGE = 7 * 24 * 3600;

export function cachedItemPath(kind, id) {
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
    return GLib.build_filenamev([cacheDir(), 'items', `${kind}-${safe}.json`]);
}

// The cached item, or null when there is none, it is unreadable, or it is
// older than its kind allows.
export async function readCachedItem(kind, id) {
    const file = Gio.File.new_for_path(cachedItemPath(kind, id));
    try {
        const [bytes] = await file.load_bytes_async(null);
        const item = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
        const cachedAt = Date.parse(item?.cached ?? '');
        const maxAge = (ITEM_MAX_AGE[kind] ?? ITEM_DEFAULT_MAX_AGE) * 1000;
        if (!item?.id || !cachedAt || Date.now() - cachedAt > maxAge)
            return null;
        return item;
    } catch {
        return null;
    }
}
