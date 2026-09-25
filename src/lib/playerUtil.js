// Pure helper functions for the player: time formatting, MPRIS metadata
// parsing, and time-synced lyrics lookup. Kept free of St and shell
// imports so they can be unit-tested directly in GJS with `gjs -m`.

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
