// Pure helpers for the player: time formatting, MPRIS metadata parsing and
// the time-synced lyric lookup. Free of St and shell imports so they can be
// unit-tested in plain GJS (`gjs -m tests/js/test_player_state.js`).
//
// cacheRemoteArt() is the one exception: it touches the filesystem and the
// network, but never St, so it lives here for playerWidgets.js and
// searchProvider.js to share.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Chrome reports INT64_MAX as the length of a stream it does not know the
// end of; anything past a day is taken to mean "unknown".
const MAX_LENGTH_US = 24 * 60 * 60 * 1e6;

// "3:24", "-0:45" for time remaining, "1:02:30" past the hour. Tabular
// figures are the stylesheet's job.
export function formatTime(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds))
        return '0:00';
    const whole = Math.abs(Math.floor(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = String(whole % 60).padStart(2, '0');
    const text = hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
        : `${minutes}:${rest}`;
    return seconds < 0 ? `-${text}` : text;
}

// The catalog id in an Apple Music URL (`?i=` for a song on an album page,
// else the last number in a /song/ or /album/ path), or the first long run
// of digits in an MPRIS track id.
export function parseCatalogId(url, trackId) {
    if (typeof url === 'string') {
        const id = url.match(/[?&]i=(\d+)/)?.[1] ?? url.match(/\/(?:song|album)\/[^/]+\/(\d+)/)?.[1];
        if (id)
            return id;
    }
    return (typeof trackId === 'string' && trackId.match(/(\d{6,})/)?.[1]) || null;
}

// An MPRIS Metadata dictionary as one track, or null when it holds no track.
export function parseMprisMetadata(meta) {
    if (!meta || typeof meta !== 'object')
        return null;
    const text = value => (typeof value === 'string' ? value : String(value || ''));
    const rawArtist = meta['xesam:artist'];
    const artist = Array.isArray(rawArtist) ? rawArtist.filter(Boolean).join(', ') : text(rawArtist);
    const title = text(meta['xesam:title']);
    const artUrl = meta['mpris:artUrl'];
    const trackId = meta['mpris:trackid'];
    const url = meta['xesam:url'];
    let lengthUs = Math.max(0, Math.round(Number(meta['mpris:length']) || 0));
    if (lengthUs > MAX_LENGTH_US)
        lengthUs = 0;
    if (!title && !lengthUs && !trackId)
        return null;
    return {
        title,
        artist,
        album: text(meta['xesam:album']),
        artUrl: typeof artUrl === 'string' && artUrl ? artUrl : null,
        lengthUs,
        trackId: typeof trackId === 'string' ? trackId : null,
        url: typeof url === 'string' ? url : null,
        catalogId: parseCatalogId(url, trackId),
    };
}

// The index of the lyric line for `positionMs` — the last one starting at or
// before it — or -1 before the first. A line stays lit through the gap after
// it, so an instrumental break keeps the last line rather than none.
export function findLyricIndex(lines, positionMs) {
    if (!Array.isArray(lines) || lines.length === 0 || positionMs < lines[0].startMs)
        return -1;
    let low = 0;
    let high = lines.length - 1;
    let best = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].startMs <= positionMs) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best;
}

// MPRIS hands the now-playing art over as an https URL (Chrome's media
// session), and a search hit carries only its catalog artwork URL, so both
// have to be fetched rather than read. Fetched once per URL into a small
// cache of its own and reused after that; resolves with a local path for a
// `background-image: url("file://...")` style or a Gio.FileIcon, the way
// every other piece of artwork in the app is drawn, or null when the fetch
// failed or was cancelled.
const ART_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-menu', 'remote-art']);

export function cacheRemoteArt(url, cancellable = null) {
    return new Promise(resolve => {
        if (!url || typeof url !== 'string') {
            resolve(null);
            return;
        }
        const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([ART_CACHE_DIR, `${digest}.img`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            resolve(path);
            return;
        }
        Gio.File.new_for_uri(url).load_bytes_async(cancellable, (file, res) => {
            let bytes;
            try {
                [bytes] = file.load_bytes_finish(res);
            } catch {
                resolve(null);
                return;
            }
            // Best effort: a cache directory that fails to create just means
            // the art is fetched again next time, not a broken player.
            GLib.mkdir_with_parents(ART_CACHE_DIR, 0o700);
            Gio.File.new_for_path(path).replace_contents_bytes_async(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable,
                (dest, res2) => {
                    try {
                        dest.replace_contents_finish(res2);
                        resolve(path);
                    } catch {
                        resolve(null);
                    }
                });
        });
    });
}
