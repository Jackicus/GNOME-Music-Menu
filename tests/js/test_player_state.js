// Unit test for player state pure helpers (playerUtil.js).
// Run with: gjs -m tests/js/test_player_state.js

import {formatTime, parseCatalogId, parseMprisMetadata, findLyricIndex} from '../../src/lib/playerUtil.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function testFormatTime() {
    assertEqual(formatTime(0), '0:00', 'formatTime(0)');
    assertEqual(formatTime(5), '0:05', 'formatTime(5)');
    assertEqual(formatTime(45), '0:45', 'formatTime(45)');
    assertEqual(formatTime(59), '0:59', 'formatTime(59)');
    assertEqual(formatTime(60), '1:00', 'formatTime(60)');
    assertEqual(formatTime(84), '1:24', 'formatTime(84)');
    assertEqual(formatTime(84.7), '1:24', 'formatTime(84.7) truncated');
    assertEqual(formatTime(216), '3:36', 'formatTime(216)');
    assertEqual(formatTime(599), '9:59', 'formatTime(599)');
    assertEqual(formatTime(600), '10:00', 'formatTime(600)');
    assertEqual(formatTime(3599), '59:59', 'formatTime(3599)');
    assertEqual(formatTime(3600), '1:00:00', 'formatTime(3600)');
    assertEqual(formatTime(3665), '1:01:05', 'formatTime(3665)');
    assertEqual(formatTime(7322), '2:02:02', 'formatTime(7322)');
    assertEqual(formatTime(-45), '-0:45', 'formatTime(-45)');
    assertEqual(formatTime(-84), '-1:24', 'formatTime(-84)');
    assertEqual(formatTime(-84.9), '-1:25', 'formatTime(-84.9)');
    assertEqual(formatTime(-3665), '-1:01:05', 'formatTime(-3665)');
    assertEqual(formatTime(NaN), '0:00', 'formatTime(NaN)');
    assertEqual(formatTime(null), '0:00', 'formatTime(null)');
    assertEqual(formatTime(undefined), '0:00', 'formatTime(undefined)');
    assertEqual(formatTime('string'), '0:00', 'formatTime("string")');
    assertEqual(formatTime({}), '0:00', 'formatTime({})');
}

function testParseCatalogId() {
    assertEqual(
        parseCatalogId('https://music.apple.com/us/album/song-name/12345678?i=987654321', null),
        '987654321',
        'parseCatalogId with ?i= query parameter'
    );
    assertEqual(
        parseCatalogId('https://music.apple.com/gb/album/album-name/12345?foo=bar&i=11223344', null),
        '11223344',
        'parseCatalogId with &i= query parameter'
    );
    assertEqual(
        parseCatalogId('https://music.apple.com/us/album/some-album/1724040700', null),
        '1724040700',
        'parseCatalogId with album path'
    );
    assertEqual(
        parseCatalogId('https://music.apple.com/us/song/some-song/1724040799', null),
        '1724040799',
        'parseCatalogId with song path'
    );
    assertEqual(
        parseCatalogId(null, '/org/mpris/MediaPlayer2/track/1724040711'),
        '1724040711',
        'parseCatalogId from mpris trackid'
    );
    assertEqual(
        parseCatalogId(null, 'i.1234567'),
        '1234567',
        'parseCatalogId from item track id'
    );
    assertEqual(
        parseCatalogId('https://music.apple.com/us/browse', 'track-12'),
        null,
        'parseCatalogId with too short digits in trackid'
    );
    assertEqual(parseCatalogId(null, null), null, 'parseCatalogId with nulls');
    assertEqual(parseCatalogId(123, 456), null, 'parseCatalogId with non-strings');
}

function testParseMprisMetadata() {
    const raw = {
        'xesam:title': 'Rise or Die Trying',
        'xesam:artist': ['Four Year Strong', 'Guest Artist'],
        'xesam:album': 'Rise or Die Trying',
        'mpris:artUrl': 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/art.jpg/512x512bb.jpg',
        'mpris:length': 216000000, // 216s in microseconds
        'mpris:trackid': '/org/mpris/MediaPlayer2/track/1724040711',
        'xesam:url': 'https://music.apple.com/us/album/rise-or-die-trying/1724040700?i=1724040711',
    };

    const parsed = parseMprisMetadata(raw);
    assert(parsed !== null, 'parsed track should not be null');
    assertEqual(parsed.title, 'Rise or Die Trying', 'title');
    assertEqual(parsed.artist, 'Four Year Strong, Guest Artist', 'artist');
    assertEqual(parsed.album, 'Rise or Die Trying', 'album');
    assertEqual(parsed.artUrl, 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/art.jpg/512x512bb.jpg', 'artUrl');
    assertEqual(parsed.lengthUs, 216000000, 'lengthUs');
    assertEqual(parsed.trackId, '/org/mpris/MediaPlayer2/track/1724040711', 'trackId');
    assertEqual(parsed.catalogId, '1724040711', 'catalogId');

    // Single artist string
    const singleArtist = parseMprisMetadata({
        'xesam:title': 'Single Artist Track',
        'xesam:artist': 'Solo Artist',
        'mpris:length': 180000000,
    });
    assertEqual(singleArtist.artist, 'Solo Artist', 'single artist string');

    // Empty/filtered artist list
    const filteredArtist = parseMprisMetadata({
        'xesam:title': 'Track',
        'xesam:artist': ['Valid', '', null, 'Also Valid'],
        'mpris:length': 1000000,
    });
    assertEqual(filteredArtist.artist, 'Valid, Also Valid', 'filtered artist array');

    // Track with empty artUrl should normalize to null
    const emptyArt = parseMprisMetadata({
        'xesam:title': 'No Art Track',
        'mpris:artUrl': '',
        'mpris:length': 1000000,
    });
    assertEqual(emptyArt.artUrl, null, 'empty string artUrl normalizes to null');

    // Track identified only by trackid
    const trackIdOnly = parseMprisMetadata({
        'mpris:trackid': '/track/1234567',
    });
    assert(trackIdOnly !== null, 'trackId only is valid');
    assertEqual(trackIdOnly.title, '', 'missing title defaults to empty string');
    assertEqual(trackIdOnly.lengthUs, 0, 'missing length defaults to 0');

    // Negative length clamped to 0
    const negativeLength = parseMprisMetadata({
        'xesam:title': 'Track',
        'mpris:length': -500,
    });
    assertEqual(negativeLength.lengthUs, 0, 'negative length clamps to 0');

    // Empty or non-track metadata
    assertEqual(parseMprisMetadata({}), null, 'empty metadata returns null');
    assertEqual(parseMprisMetadata(null), null, 'null metadata returns null');
    assertEqual(parseMprisMetadata(undefined), null, 'undefined metadata returns null');
    assertEqual(parseMprisMetadata('not-an-object'), null, 'string metadata returns null');
}

function testFindLyricIndex() {
    const lines = [
        {startMs: 1000, endMs: 4000, text: 'First line'},
        {startMs: 4500, endMs: 8000, text: 'Second line'},
        {startMs: 9000, endMs: 12000, text: 'Third line'},
    ];

    assertEqual(findLyricIndex(lines, 500), -1, 'before first line');
    assertEqual(findLyricIndex(lines, 1000), 0, 'at first line start');
    assertEqual(findLyricIndex(lines, 2500), 0, 'in middle of first line');
    assertEqual(findLyricIndex(lines, 4000), 0, 'at first line end (gap keeps line 0)');
    assertEqual(findLyricIndex(lines, 4200), 0, 'between first and second line');
    assertEqual(findLyricIndex(lines, 4500), 1, 'at second line start');
    assertEqual(findLyricIndex(lines, 8000), 1, 'in gap between second and third line');
    assertEqual(findLyricIndex(lines, 9000), 2, 'at third line start');
    assertEqual(findLyricIndex(lines, 10000), 2, 'in third line');
    assertEqual(findLyricIndex(lines, 12000), 2, 'past end of last line');
    assertEqual(findLyricIndex(lines, 20000), 2, 'far past end of last line');

    // Single line
    const single = [{startMs: 2000, endMs: 5000, text: 'Only line'}];
    assertEqual(findLyricIndex(single, 1000), -1, 'single line before start');
    assertEqual(findLyricIndex(single, 2000), 0, 'single line at start');
    assertEqual(findLyricIndex(single, 6000), 0, 'single line after end');

    // Lines without endMs
    const noEnd = [
        {startMs: 1000, text: 'Line 1'},
        {startMs: 3000, text: 'Line 2'},
    ];
    assertEqual(findLyricIndex(noEnd, 500), -1, 'noEnd before start');
    assertEqual(findLyricIndex(noEnd, 1500), 0, 'noEnd at line 1');
    assertEqual(findLyricIndex(noEnd, 3500), 1, 'noEnd at line 2');

    // Invalid arguments
    assertEqual(findLyricIndex([], 1000), -1, 'empty lines array');
    assertEqual(findLyricIndex(null, 1000), -1, 'null lines');
    assertEqual(findLyricIndex(undefined, 1000), -1, 'undefined lines');
}

function runTests() {
    testFormatTime();
    testParseCatalogId();
    testParseMprisMetadata();
    testFindLyricIndex();
    console.log('test_player_state: OK');
}

runTests();
