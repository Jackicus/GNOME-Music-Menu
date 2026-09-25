// Pure helper functions for the player: time formatting, MPRIS metadata
// parsing, and time-synced lyrics lookup. Kept free of St and shell
// imports so they can be unit-tested directly in GJS with `gjs -m`.
//
// cacheRemoteArt() is the one exception: it touches the filesystem and the
// network, but never St, so it stays here rather than in playerBar.js or
// nowPlaying.js, which both need it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Format a duration in seconds into a display string (e.g. "3:24", "-0:45", "1:02:30").
 * Tabular figure spacing is typically handled in CSS with font-variant-numeric / font-feature-settings.
 *
 * @param {number} seconds - Duration in seconds (can be negative for remaining time)
 * @returns {string} Formatted time string
 */
export function formatTime(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds))
        return '0:00';

    const isNegative = seconds < 0;
    const absSec = Math.abs(Math.floor(seconds));
    const hrs = Math.floor(absSec / 3600);
    const mins = Math.floor((absSec % 3600) / 60);
    const secs = absSec % 60;

    const padSecs = String(secs).padStart(2, '0');
    let formatted;
    if (hrs > 0) {
        const padMins = String(mins).padStart(2, '0');
        formatted = `${hrs}:${padMins}:${padSecs}`;
    } else {
        formatted = `${mins}:${padSecs}`;
    }

    return isNegative ? `-${formatted}` : formatted;
}

/**
 * Extract catalog ID from an Apple Music URL or track ID string.
 *
 * @param {string|null} url
 * @param {string|null} trackId
 * @returns {string|null}
 */
export function parseCatalogId(url, trackId) {
    if (url && typeof url === 'string') {
        // e.g. https://music.apple.com/us/album/song-name/12345?i=67890
        const queryMatch = url.match(/[?&]i=(\d+)/);
        if (queryMatch)
            return queryMatch[1];

        // e.g. /song/12345678 or catalog id at end of path
        const pathMatch = url.match(/\/(?:song|album)\/[^/]+\/(\d+)/);
        if (pathMatch)
            return pathMatch[1];
    }

    if (trackId && typeof trackId === 'string') {
        const idMatch = trackId.match(/(\d{6,})/);
        if (idMatch)
            return idMatch[1];
    }

    return null;
}

/**
 * Parse an MPRIS Metadata dictionary into a normalized track object.
 *
 * @param {Object} meta - The raw MPRIS metadata dictionary
 * @returns {Object|null} Normalized track or null if no track is playing
 */
export function parseMprisMetadata(meta) {
    if (!meta || typeof meta !== 'object')
        return null;

    let title = meta['xesam:title'] ?? '';
    if (typeof title !== 'string')
        title = String(title || '');

    let artist = '';
    const rawArtist = meta['xesam:artist'];
    if (Array.isArray(rawArtist))
        artist = rawArtist.filter(Boolean).join(', ');
    else if (typeof rawArtist === 'string')
        artist = rawArtist;

    let album = meta['xesam:album'] ?? '';
    if (typeof album !== 'string')
        album = String(album || '');

    const artUrl = meta['mpris:artUrl'] ?? null;
    const lengthUs = Math.max(0, Math.round(Number(meta['mpris:length']) || 0));
    const trackId = meta['mpris:trackid'] ?? null;
    const url = meta['xesam:url'] ?? null;
    const catalogId = parseCatalogId(url, trackId);

    // If there is no title and no length and no trackId, it's not a valid track
    if (!title && !lengthUs && !trackId)
        return null;

    return {
        title,
        artist,
        album,
        artUrl: typeof artUrl === 'string' && artUrl ? artUrl : null,
        lengthUs,
        trackId: typeof trackId === 'string' ? trackId : null,
        url: typeof url === 'string' ? url : null,
        catalogId,
    };
}

/**
 * Find the index of the currently active lyric line for a given playback position.
 *
 * @param {Array<{startMs: number, endMs?: number, text: string}>} lines - Sorted lyric lines
 * @param {number} positionMs - Current playback position in milliseconds
 * @returns {number} Index of active line, or -1 if before the first line
 */
export function findLyricIndex(lines, positionMs) {
    if (!Array.isArray(lines) || lines.length === 0)
        return -1;

    if (positionMs < lines[0].startMs)
        return -1;

    // Binary search for the line starting at or just before positionMs
    let low = 0;
    let high = lines.length - 1;
    let best = 0;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lines[mid].startMs <= positionMs) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    // Check if line has an explicit endMs and positionMs has exceeded it
    const line = lines[best];
    if (line.endMs && positionMs >= line.endMs) {
        // If there is a next line and we are before it, we may be in an instrumental gap
        if (best + 1 < lines.length && positionMs < lines[best + 1].startMs)
            return best; // Keep current line highlighted during short pause
    }

    return best;
}

// MPRIS hands over the now-playing art as an https URL (Chrome's own media
// session), not a path in the library's art cache, so it has to be fetched
// rather than read. Fetched once per URL into a small cache of its own and
// reused after that; resolves with a local path the caller can drop straight
// into a `background-image: url("file://...")` style the way every other
// piece of artwork in the app is drawn, or null if the fetch failed or a
// newer request superseded it.
const ART_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-menu', 'mpris-art']);

export function cacheRemoteArt(url, cancellable = null) {
    return new Promise(resolve => {
        if (!url || typeof url !== 'string') {
            resolve(null);
            return;
        }

        let digest;
        try {
            digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        } catch {
            resolve(null);
            return;
        }
        const path = GLib.build_filenamev([ART_CACHE_DIR, `${digest}.img`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            resolve(path);
            return;
        }

        let source;
        try {
            source = Gio.File.new_for_uri(url);
        } catch {
            resolve(null);
            return;
        }

        source.load_bytes_async(cancellable, (file, res) => {
            let bytes;
            try {
                [bytes] = file.load_bytes_finish(res);
            } catch {
                resolve(null);
                return;
            }

            // Best-effort: a cache directory that fails to create just means
            // the art is fetched again next time, not a broken player.
            GLib.mkdir_with_parents(ART_CACHE_DIR, 0o700);

            const dest = Gio.File.new_for_path(path);
            dest.replace_contents_bytes_async(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable,
                (d, res2) => {
                    try {
                        d.replace_contents_finish(res2);
                        resolve(path);
                    } catch {
                        resolve(null);
                    }
                }
            );
        });
    });
}
