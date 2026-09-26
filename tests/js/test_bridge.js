// Unit test for the page-side bridge's write path (src/backend/bridge.js).
// Run with: node tests/js/test_bridge.js
//
// bridge.js is a plain script that installs window.__musicMenu, so it is
// run against a stand-in window whose MusicKit records what was sent and
// answers with a canned response. It runs in this context, not a fresh vm
// one, so the objects it makes compare equal to the literals below. Apple
// answers writes with 202 or 204 and an empty body, so that case is the one
// that matters most here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/backend/bridge.js'), 'utf8');

function response(status, body) {
    const statusText = {200: 'OK', 202: 'Accepted', 204: 'No Content', 403: 'Forbidden', 502: 'Bad Gateway'}[status];
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        text: async () => body,
        json: async () => JSON.parse(body),
    };
}

// A window whose MusicKit answers every request with `reply` and keeps what
// was sent in `sent`. `music()` throws so a write that regresses onto it fails
// loudly here.
function load(reply) {
    const sent = [];
    const window = {
        MusicKit: {
            getInstance: () => ({
                api: {
                    client: {
                        createRequest(requestPath, options) {
                            sent.push({path: requestPath, ...options});
                            return {send: async () => reply};
                        },
                    },
                    music: async () => {
                        throw new Error('writes must not go through music()');
                    },
                },
            }),
        },
    };
    globalThis.window = window;
    vm.runInThisContext(source);
    return {bridge: window.__musicMenu, sent};
}

async function rejectsWith(promise, fragment) {
    try {
        await promise;
    } catch (e) {
        assert.ok(e.message.includes(fragment), `expected "${fragment}" in "${e.message}"`);
        return;
    }
    throw new Error(`expected rejection mentioning "${fragment}"`);
}

async function testAddToLibraryEmptyBodyIsSuccess() {
    const {bridge, sent} = load(response(202, ''));
    assert.deepStrictEqual(await bridge.addToLibrary('song', '123'), {ok: true});
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].path, '/v1/me/library');
    assert.strictEqual(sent[0].method, 'POST');
    assert.deepStrictEqual(sent[0].params, {'ids[songs]': '123'});
    assert.strictEqual(sent[0].body, undefined);
}

async function testRefusalSurfacesAppleMessage() {
    const body = JSON.stringify({errors: [{title: 'Forbidden', detail: 'No active subscription'}]});
    const {bridge} = load(response(403, body));
    await rejectsWith(bridge.addToLibrary('album', '9'), 'HTTP 403 Forbidden: No active subscription');
}

async function testRefusalWithoutJsonBody() {
    const {bridge} = load(response(502, '<html>bad gateway</html>'));
    await rejectsWith(bridge.addToLibrary('album', '9'), 'HTTP 502 Bad Gateway');
}

async function testRatingSendsObjectBody() {
    const loved = load(response(200, '{"data":[]}'));
    assert.deepStrictEqual(await loved.bridge.rating('song', '5', true), {ok: true});
    assert.strictEqual(loved.sent[0].path, '/v1/me/ratings/songs/5');
    assert.strictEqual(loved.sent[0].method, 'PUT');
    // A plain object, so MusicKit serializes it and sets the JSON content type.
    assert.deepStrictEqual(loved.sent[0].body, {type: 'ratings', attributes: {value: 1}});

    const unloved = load(response(204, ''));
    assert.deepStrictEqual(await unloved.bridge.rating('song', '5', false), {ok: true});
    assert.strictEqual(unloved.sent[0].method, 'DELETE');
    assert.strictEqual(unloved.sent[0].body, undefined);
}

async function testAddToPlaylist() {
    const {bridge, sent} = load(response(204, ''));
    assert.deepStrictEqual(await bridge.addToPlaylist('p.abc', '123'), {ok: true});
    assert.strictEqual(sent[0].path, '/v1/me/library/playlists/p.abc/tracks');
    assert.strictEqual(sent[0].method, 'POST');
    assert.deepStrictEqual(sent[0].body, {data: [{id: '123', type: 'songs'}]});
}

// The level is clamped to MusicKit's 0..1 and answered as it was set.
async function testVolumeIsClampedAndAnswered() {
    const {bridge} = load(response(200, '{}'));
    assert.deepStrictEqual(await bridge.volume(0.5), {volume: 0.5});
    assert.deepStrictEqual(await bridge.volume('0.25'), {volume: 0.25});
    assert.deepStrictEqual(await bridge.volume(1.7), {volume: 1});
    assert.deepStrictEqual(await bridge.volume(-2), {volume: 0});
    assert.deepStrictEqual(await bridge.volume('nonsense'), {volume: 0});
}

// A window whose MusicKit answers reads by path: `answers` maps a path to
// what `music()` resolves with, or to an Error to throw.
function loadReads(answers) {
    const asked = [];
    globalThis.window = {
        MusicKit: {
            getInstance: () => ({
                storefrontId: 'gb',
                api: {
                    music: async (requestPath, params) => {
                        asked.push({path: requestPath, params});
                        const answer = answers[requestPath];
                        if (answer instanceof Error)
                            throw answer;
                        return {data: answer};
                    },
                },
            }),
        },
    };
    vm.runInThisContext(source);
    return {bridge: window.__musicMenu, asked};
}

// The search and its completions in one call, each asked for as it is on
// its own; the completions failing costs the search nothing.
async function testSearchAndSuggestIsBothAtOnce() {
    const search = {results: {songs: {data: [{id: '1'}]}}};
    const suggestions = {results: {suggestions: [{kind: 'terms', searchTerm: 'shout'}]}};
    const {bridge, asked} = loadReads({
        '/v1/catalog/gb/search': search,
        '/v1/catalog/gb/search/suggestions': suggestions,
    });
    assert.deepStrictEqual(await bridge.searchAndSuggest('sho', false, 10, 3), {search, suggestions});
    assert.deepStrictEqual(asked.map(a => a.path), ['/v1/catalog/gb/search', '/v1/catalog/gb/search/suggestions']);
    assert.deepStrictEqual(asked[0].params, {term: 'sho', types: 'albums,artists,music-videos,playlists,songs,stations', limit: 10, with: 'topResults'});
    assert.deepStrictEqual(asked[1].params, {term: 'sho', kinds: 'terms,topResults', types: 'albums,artists,music-videos,playlists,songs,stations', limit: 3});
    // Alone, each is the same request.
    assert.deepStrictEqual(await bridge.search('sho', false, 10), search);
    assert.deepStrictEqual(await bridge.suggest('sho', 3), suggestions);

    const failing = loadReads({
        '/v1/catalog/gb/search': search,
        '/v1/catalog/gb/search/suggestions': new Error('no completions today'),
    });
    assert.deepStrictEqual(await failing.bridge.searchAndSuggest('sho', false, 10, 3), {search, suggestions: null});
    await rejectsWith(failing.bridge.suggest('sho', 3), 'no completions today');
}

async function testMissingClientIsAClearError() {
    globalThis.window = {MusicKit: {getInstance: () => ({api: {music: async () => ({})}})}};
    vm.runInThisContext(source);
    await rejectsWith(window.__musicMenu.addToLibrary('song', '1'), 'request client unavailable');
}

(async () => {
    const tests = [
        testAddToLibraryEmptyBodyIsSuccess,
        testRefusalSurfacesAppleMessage,
        testRefusalWithoutJsonBody,
        testRatingSendsObjectBody,
        testAddToPlaylist,
        testVolumeIsClampedAndAnswered,
        testSearchAndSuggestIsBothAtOnce,
        testMissingClientIsAClearError,
    ];
    for (const test of tests)
        await test();
    console.log(`test_bridge: ${tests.length} tests passed`);
})().catch(e => {
    console.error(e.stack || e);
    process.exit(1);
});
