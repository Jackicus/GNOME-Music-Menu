// Reads ~/.cache/music-menu/library.json (written by backend/am.py sync) and
// resolves it into what the views render. The Item and shelf shapes are
// am.py's own — see AGENTS.md — and are used as they come off disk; the one
// thing this module does is check each item's `art` against what is actually
// in the cache, so a cleared cache reads as no artwork rather than a broken
// background image.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SIGN_IN_HINT = 'Sign in to Apple Music in Settings, then press Sync.';

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

// Which sections are switched on, in SECTIONS' own order — read by app.js to
// decide which tabs and grids to build, and by prefs.js for the toggles.
export function enabledSections(settings) {
    return SECTIONS.filter(section => settings.get_boolean(`${section.prefix}-enabled`));
}

function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-menu']);
}

export function libraryPath() {
    return GLib.build_filenamev([cacheDir(), 'library.json']);
}

// The file as am.py wrote it: the raw per-section arrays, the shelves and
// when it last ran.
export function readSections() {
    const nothing = {sections: {}, shelves: [], generated: null};
    const path = libraryPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return nothing;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return nothing;
        const raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        return {
            sections: raw?.sections ?? {},
            shelves: Array.isArray(raw?.shelves) ? raw.shelves : [],
            generated: raw?.generated ?? null,
        };
    } catch (e) {
        console.error(`[Music Menu] Failed to read ${path}: ${e}`);
        return nothing;
    }
}

// {albums: [Item], artists: [Item], playlists: [Item], radio: [Item],
// 'listen-now': [], shelves: [{key, title, items: [Item]}]}. Listen Now has
// no grid of its own — only its shelves, which shelfView.js renders — so its
// key is always the empty array. Missing or unreadable files yield empty
// sections, never fake data.
export function loadLibrary() {
    const {sections, shelves} = readSections();
    const art = artworkIndex();
    const out = Object.fromEntries(SECTIONS.map(section => [section.key, []]));
    for (const section of SECTIONS) {
        if (section.shelves)
            continue;
        const items = sections[section.key];
        if (Array.isArray(items))
            out[section.key] = items.map(item => normalize(item, art)).filter(Boolean);
    }
    out.shelves = shelves.map(shelf => ({
        key: shelf.key,
        title: shelf.title,
        items: Array.isArray(shelf.items) ? shelf.items.map(item => normalize(item, art)).filter(Boolean) : [],
    }));
    return out;
}

// ---------------------------------------------------------------------------
// Is the artwork still there?
//
// Every `art` path is am.py's own, under <cache>/art/, already scaled to
// what the desktop draws (512x512). A path in library.json can outlive the
// file it names — a cleared cache — and St paints a missing background image
// as nothing at all, so the drawn placeholder would never get its turn.
// Checking costs a blocking stat per item though, and this runs on the
// compositor's main loop for every item in every section and shelf, so the
// art folder is listed once and the check becomes a lookup rather than a
// stat each. A path outside the cache counts as missing rather than earning
// a stat of its own.
// ---------------------------------------------------------------------------
function artworkIndex() {
    const dir = GLib.build_filenamev([cacheDir(), 'art']);
    const names = new Set();
    let children;
    try {
        children = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (e) {
        return {dir, names};   // the folder is not there yet: nothing is cached
    }
    let info;
    while ((info = children.next_file(null)) !== null)
        names.add(info.get_name());
    children.close(null);
    return {dir, names};
}

function exists(path, art) {
    if (!path)
        return false;
    const cut = path.lastIndexOf('/');
    return path.slice(0, cut) === art.dir && art.names.has(path.slice(cut + 1));
}

function normalize(item, art) {
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
        art: exists(item.art, art) ? item.art : null,
        artColor: item.artColor ?? null,
        countLabel: item.countLabel ?? null,
        explicit: !!item.explicit,
        catalogId: item.catalogId ?? null,
        url: item.url ?? null,
        play: item.play ?? null,
        groups: Array.isArray(item.groups) ? item.groups : [],
    };
}
