// Unit test for library.js's pure parts: the content stamp a sync's rewrite
// is judged by, and the on-disk copy of an item fetched on demand.
// Run with: XDG_CACHE_HOME=$(mktemp -d) gjs -m tests/js/test_library.js
//
// The cache directory must be a scratch one: GLib settles the user's cache
// directory as the process starts, before any script runs, so it has to
// come from the environment — and the test refuses to touch the real one.

import GLib from 'gi://GLib';

import {cacheDir, cachedItemPath, contentStamp, readCachedItem} from '../../src/lib/library.js';

const scratch = GLib.getenv('XDG_CACHE_HOME');
if (!scratch || !cacheDir().startsWith(scratch))
    throw new Error('Run with XDG_CACHE_HOME set to a scratch directory; this test writes to the cache.');

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function testStampIgnoresGenerated() {
    const a = '{\n  "version": 1,\n  "generated": "2026-09-25T12:00:00Z",\n  "sections": {}\n}';
    const b = a.replace('2026-09-25T12:00:00Z', '2026-09-26T09:30:00+00:00');
    const c = a.replace('"sections": {}', '"sections": {"albums": []}');
    assertEqual(contentStamp(a), contentStamp(b), 'a new generated time is the same library');
    assert(contentStamp(a) !== contentStamp(c), 'a changed section is a different library');
    assertEqual(contentStamp(a).length, 64, 'a sha256 in hex');
}

function testCachedItemPathIsSafe() {
    const path = cachedItemPath('album', 'l.abc/../x y');
    assert(path.startsWith(GLib.build_filenamev([cacheDir(), 'items', 'album-'])), `under items/: ${path}`);
    assertEqual(GLib.path_get_basename(path), 'album-l.abc_.._x_y.json', 'unsafe characters replaced');
}

async function testReadCachedItem() {
    assertEqual(await readCachedItem('album', 'none'), null, 'nothing cached');
    const write = (kind, id, item) => {
        const path = cachedItemPath(kind, id);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        GLib.file_set_contents(path, JSON.stringify(item));
    };
    const now = new Date();
    write('album', 'l.1', {id: 'l.1', kind: 'album', groups: [{name: 'Disc 1', entries: []}], cached: now.toISOString()});
    assertEqual((await readCachedItem('album', 'l.1'))?.id, 'l.1', 'a fresh album is read back');

    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();
    write('album', 'l.2', {id: 'l.2', kind: 'album', cached: twoDaysAgo});
    write('playlist', 'p.2', {id: 'p.2', kind: 'playlist', cached: twoDaysAgo});
    assertEqual((await readCachedItem('album', 'l.2'))?.id, 'l.2', 'an album keeps for a week');
    assertEqual(await readCachedItem('playlist', 'p.2'), null, 'a playlist is asked for again after a day');

    write('album', 'l.3', {id: 'l.3', kind: 'album'});
    assertEqual(await readCachedItem('album', 'l.3'), null, 'no time of caching is no cache');
    GLib.file_set_contents(cachedItemPath('album', 'l.4'), 'not json');
    assertEqual(await readCachedItem('album', 'l.4'), null, 'an unreadable file is no cache');
}

function removeTree(path) {
    const dir = GLib.Dir.open(path, 0);
    let name;
    while ((name = dir.read_name()) !== null) {
        const child = GLib.build_filenamev([path, name]);
        if (GLib.file_test(child, GLib.FileTest.IS_DIR) && !GLib.file_test(child, GLib.FileTest.IS_SYMLINK))
            removeTree(child);
        else
            GLib.unlink(child);
    }
    dir.close();
    GLib.rmdir(path);
}

try {
    testStampIgnoresGenerated();
    testCachedItemPathIsSafe();
    await testReadCachedItem();
    print('test_library: OK');
} finally {
    removeTree(cacheDir());
}
