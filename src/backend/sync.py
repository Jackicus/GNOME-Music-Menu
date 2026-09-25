"""Library synchronization, Apple Music API normalization, and artwork caching.

Transforms Apple Music API JSON into the Item and Track schemas defined in AGENTS.md,
manages artwork caching and pruning, and builds library.json.
Python standard library only.
"""

from datetime import datetime, timezone
import fcntl
import hashlib
import html
import json
import os
import re
import tempfile
import urllib.error
import urllib.request


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def format_duration(duration_ms: int | None) -> str:
    """Format milliseconds into 'm:ss' or 'h:mm:ss'.

    e.g. 216000 -> '3:36', 3661000 -> '1:01:01', 0 -> '0:00'.
    """
    if duration_ms is None or duration_ms <= 0:
        return "0:00"

    total_seconds = round(duration_ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60

    if hours > 0:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def format_count_label(song_count: int | None, total_duration_ms: int | None = None) -> str:
    """Format song count and total duration into a count label.

    e.g. '1 song' (no duration given), '12 songs, 43 min', '20 songs, 1 hr 15 min'.
    """
    count = max(0, int(song_count)) if song_count is not None else 0

    song_word = "song" if count == 1 else "songs"
    songs_part = f"{count} {song_word}"

    if total_duration_ms is None:
        return songs_part

    duration = max(0, int(total_duration_ms))

    if duration == 0:
        dur_part = "0 min"
    else:
        total_minutes = round(duration / 60000)
        if total_minutes == 0:
            total_minutes = 1

        hours = total_minutes // 60
        minutes = total_minutes % 60

        if hours > 0:
            if minutes > 0:
                dur_part = f"{hours} hr {minutes} min"
            else:
                dur_part = f"{hours} hr"
        else:
            dur_part = f"{minutes} min"

    return f"{songs_part}, {dur_part}"


def format_color(bg_color: str | None) -> str | None:
    """Normalize hex color string to #rrggbb or None."""
    if not bg_color:
        return None
    bg_color = bg_color.strip()
    if not bg_color:
        return None
    if not bg_color.startswith("#"):
        return f"#{bg_color}"
    return bg_color


def strip_html(text: str | None) -> str | None:
    """Convert HTML snippet to plain text or None."""
    if not text:
        return None
    cleaned = re.sub(r"<[^>]+>", "", text)
    cleaned = html.unescape(cleaned).strip()
    return cleaned if cleaned else None


# ---------------------------------------------------------------------------
# Artwork templating, caching, and pruning
# ---------------------------------------------------------------------------


def template_artwork_url(url_template: str, width: int = 512, height: int = 512) -> str:
    """Format an Apple Music artwork URL template by replacing dimensions and formats.

    Replaces {w} with width, {h} with height. Also {f} with 'jpg', {c} with 'bb' if present.
    """
    if not url_template:
        return ""
    return (
        url_template.replace("{w}x{h}", f"{width}x{height}")
        .replace("{w}", str(width))
        .replace("{h}", str(height))
        .replace("{f}", "jpg")
        .replace("{c}", "bb")
    )


def format_artwork_url(artwork_obj, width: int = 512, height: int = 512) -> str | None:
    """Convenience wrapper for dict artwork object or string template."""
    if not artwork_obj:
        return None
    if isinstance(artwork_obj, dict):
        url = artwork_obj.get("url")
    else:
        url = str(artwork_obj)
    if not url:
        return None
    return template_artwork_url(url, width, height)


def artwork_filename(url: str) -> str:
    """Return the SHA-1 cache filename for an artwork URL."""
    if not url:
        return ""
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return f"{digest}.jpg"


def artwork_cache_path(url: str, cache_dir: str) -> str:
    """Return the absolute path in the cache directory for an artwork URL."""
    return os.path.join(cache_dir, "art", artwork_filename(url))


def get_artwork_cache_path(url: str, cache_dir: str) -> str | None:
    """Alias for artwork_cache_path with None safety."""
    if not url or not cache_dir:
        return None
    return artwork_cache_path(url, cache_dir)


def cache_artwork(url_or_obj, cache_dir: str, timeout: float = 10.0) -> str | None:
    """Download artwork via urllib.request and save it atomically to <cache_dir>/art/.

    Accepts either an artwork URL string or an Apple Music artwork dictionary.
    Writes to a temporary file in the art directory, flushes, fsyncs, and replaces atomically.
    Returns the absolute local file path on success, or None on error.
    """
    if not url_or_obj or not cache_dir:
        return None

    if isinstance(url_or_obj, dict):
        url = format_artwork_url(url_or_obj)
    else:
        url = str(url_or_obj)

    if not url:
        return None

    art_dir = os.path.join(cache_dir, "art")
    dest_path = os.path.abspath(artwork_cache_path(url, cache_dir))

    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
        return dest_path

    try:
        os.makedirs(art_dir, exist_ok=True)
    except OSError:
        return None

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "MusicMenu/1.0"}
    )

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=art_dir, delete=False, suffix=".tmp") as f:
            temp_path = f.name
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status = getattr(resp, "status", 200)
                if status != 200:
                    return None
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
            f.flush()
            os.fsync(f.fileno())

        os.replace(temp_path, dest_path)
        temp_path = None
        return dest_path
    except Exception:
        return None
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def collect_art_paths(library_data: dict) -> set[str]:
    """Collect all referenced local artwork paths from a library data dict."""
    paths = set()
    for sec_items in library_data.get("sections", {}).values():
        for item in sec_items:
            if item.get("art"):
                paths.add(os.path.abspath(item["art"]))
    for shelf in library_data.get("shelves", []):
        for item in shelf.get("items", []):
            if item.get("art"):
                paths.add(os.path.abspath(item["art"]))
    return paths


def prune_art(cache_dir_or_data, referenced_paths_or_cache_dir=None) -> int:
    """Remove artwork files in <cache_dir>/art/ that are no longer referenced.

    Supports two signatures:
      prune_art(cache_dir: str, referenced_paths: set[str]) -> int
      prune_art(library_data: dict, cache_dir: str) -> int
    Returns the count of pruned files.
    """
    if isinstance(cache_dir_or_data, dict):
        library_data = cache_dir_or_data
        cache_dir = referenced_paths_or_cache_dir
        referenced_paths = collect_art_paths(library_data)
    else:
        cache_dir = cache_dir_or_data
        referenced_paths = referenced_paths_or_cache_dir if referenced_paths_or_cache_dir is not None else set()

    if not cache_dir:
        return 0

    art_dir = os.path.join(cache_dir, "art")
    if not os.path.isdir(art_dir):
        return 0

    norm_refs = set()
    for p in referenced_paths:
        if p:
            norm_refs.add(os.path.abspath(p))
            norm_refs.add(os.path.basename(p))

    pruned = 0
    try:
        for entry in os.listdir(art_dir):
            file_path = os.path.join(art_dir, entry)
            abs_path = os.path.abspath(file_path)
            if abs_path not in norm_refs and entry not in norm_refs:
                try:
                    if os.path.isfile(file_path) or os.path.islink(file_path):
                        os.remove(file_path)
                        pruned += 1
                except OSError:
                    pass
    except OSError:
        pass

    return pruned


# ---------------------------------------------------------------------------
# Internal extraction helpers
# ---------------------------------------------------------------------------


def _extract_year(attrs: dict, raw_item: dict) -> int | None:
    """Extract release year from Apple Music attributes or raw item."""
    rel_date = attrs.get("releaseDate") or raw_item.get("releaseDate")
    if rel_date and isinstance(rel_date, str) and len(rel_date) >= 4:
        try:
            return int(rel_date[:4])
        except ValueError:
            pass

    year = attrs.get("year") or raw_item.get("year")
    if year is not None:
        try:
            return int(year)
        except (ValueError, TypeError):
            pass

    # Playlists have no release date; fall back to when they were last
    # modified so the UI still has a year to show.
    mod_date = attrs.get("lastModifiedDate") or raw_item.get("lastModifiedDate")
    if mod_date and isinstance(mod_date, str) and len(mod_date) >= 4:
        try:
            return int(mod_date[:4])
        except ValueError:
            pass

    return None


def _extract_summary(attrs: dict, raw_item: dict) -> str | None:
    """Extract editorial notes or description as plain text."""
    ed = attrs.get("editorialNotes") or raw_item.get("editorialNotes")
    desc = attrs.get("description") or raw_item.get("description")
    summary = None

    if isinstance(ed, dict):
        summary = ed.get("standard") or ed.get("short") or ed.get("name")
    elif isinstance(ed, str):
        summary = ed
    elif isinstance(desc, dict):
        summary = desc.get("standard") or desc.get("short")
    elif isinstance(desc, str):
        summary = desc
    elif raw_item.get("summary"):
        summary = raw_item["summary"]

    return strip_html(summary)


def _extract_artwork(attrs: dict, raw_item: dict, cache_dir: str | None) -> tuple[str | None, str | None]:
    """Extract local cached art path and hex background color."""
    art = None
    art_color = None

    if raw_item.get("art"):
        art = raw_item["art"]
    if raw_item.get("artColor"):
        art_color = format_color(raw_item["artColor"])

    artwork = attrs.get("artwork") or raw_item.get("artwork")
    if isinstance(artwork, dict):
        url = artwork.get("url")
        if url:
            templated = template_artwork_url(url, 512, 512)
            if cache_dir:
                art = artwork_cache_path(templated, cache_dir)
        bg = artwork.get("bgColor")
        if bg and not art_color:
            art_color = format_color(bg)

    return art, art_color


def _extract_catalog_id(attrs: dict, raw_item: dict, resource_type: str) -> str | None:
    """Extract catalog ID from a catalog or library resource."""
    item_id = str(raw_item.get("id") or "")
    if raw_item.get("type") == resource_type:
        return item_id if item_id else None

    if "relationships" in raw_item:
        cat_data = raw_item["relationships"].get("catalog", {}).get("data", [])
        if cat_data and isinstance(cat_data, list) and len(cat_data) > 0:
            cid = cat_data[0].get("id")
            if cid:
                return str(cid)

    play_params = attrs.get("playParams") or {}
    if "catalogId" in play_params:
        return str(play_params["catalogId"])

    if raw_item.get("catalogId"):
        return str(raw_item["catalogId"])

    # If item_id does not look like a library id (l.*, i.*, p.*, r.*), treat as catalog ID
    if item_id and not (item_id.startswith("l.") or item_id.startswith("i.") or item_id.startswith("p.") or item_id.startswith("r.")):
        return item_id

    return None


# ---------------------------------------------------------------------------
# Item and Track Normalizers
# ---------------------------------------------------------------------------


def normalize_track(raw_track: dict, index: int = 0) -> dict:
    """Turn an Apple Music API track into the AGENTS.md Track shape.

    Track = {
      "id": "...", "catalogId": "..." | null, "title": "...", "artist": "...",
      "album": "...", "trackNumber": int, "discNumber": int, "durationMs": int,
      "durationLabel": "3:36", "explicit": bool, "index": int
    }
    """
    attrs = raw_track.get("attributes") or {}
    track_id = str(raw_track.get("id") or "")

    catalog_id = _extract_catalog_id(attrs, raw_track, "songs")

    title = attrs.get("name") or raw_track.get("title") or ""
    artist = attrs.get("artistName") or attrs.get("artist") or raw_track.get("artist") or ""
    album = attrs.get("albumName") or attrs.get("album") or raw_track.get("album") or ""

    track_number = attrs.get("trackNumber") if attrs.get("trackNumber") is not None else raw_track.get("trackNumber", 1)
    disc_number = attrs.get("discNumber") if attrs.get("discNumber") is not None else raw_track.get("discNumber", 1)
    duration_ms = attrs.get("durationInMillis") if attrs.get("durationInMillis") is not None else raw_track.get("durationMs", 0)

    try:
        track_number = int(track_number)
    except (ValueError, TypeError):
        track_number = 1

    try:
        disc_number = int(disc_number)
    except (ValueError, TypeError):
        disc_number = 1

    try:
        duration_ms = int(duration_ms)
    except (ValueError, TypeError):
        duration_ms = 0

    duration_label = format_duration(duration_ms)

    content_rating = attrs.get("contentRating") or raw_track.get("contentRating")
    is_explicit = (
        content_rating == "explicit"
        or attrs.get("explicit") is True
        or raw_track.get("explicit") is True
    )

    return {
        "id": track_id,
        "catalogId": catalog_id,
        "title": title,
        "artist": artist,
        "album": album,
        "trackNumber": track_number,
        "discNumber": disc_number,
        "durationMs": duration_ms,
        "durationLabel": duration_label,
        "explicit": is_explicit,
        "index": int(index),
    }


def normalize_album(
    raw_album: dict,
    tracks_or_cache_dir=None,
    cache_dir: str | None = None,
    tracks: list[dict] | None = None,
) -> dict:
    """Turn an Apple Music API album into the AGENTS.md Item shape with kind='album'.

    Supports both signatures:
      normalize_album(raw_album, tracks=None, cache_dir=None)
      normalize_album(raw_album, cache_dir=None, tracks=None)
    Groups tracks by discNumber: groups = [{"name": f"Disc {disc}", "play": {"kind": "album", "id": item_id}, "entries": [...]}]
    """
    if isinstance(tracks_or_cache_dir, str):
        actual_cache_dir = tracks_or_cache_dir
        actual_tracks = tracks
    else:
        actual_tracks = tracks if tracks is not None else (tracks_or_cache_dir if isinstance(tracks_or_cache_dir, list) else None)
        actual_cache_dir = cache_dir

    attrs = raw_album.get("attributes") or {}
    item_id = str(raw_album.get("id") or "")
    title = attrs.get("name") or raw_album.get("title") or ""
    subtitle = attrs.get("artistName") or raw_album.get("subtitle") or "Apple Music"
    year = _extract_year(attrs, raw_album)

    genre_names = attrs.get("genreNames") or raw_album.get("genreNames")
    genre = None
    if isinstance(genre_names, list) and len(genre_names) > 0:
        genre = genre_names[0]
    elif isinstance(genre_names, str):
        genre = genre_names
    elif raw_album.get("genre"):
        genre = raw_album["genre"]

    summary = _extract_summary(attrs, raw_album)
    art, art_color = _extract_artwork(attrs, raw_album, actual_cache_dir)
    catalog_id = _extract_catalog_id(attrs, raw_album, "albums")
    url = attrs.get("url") or raw_album.get("url")

    # Resolve track list
    raw_tracks = actual_tracks
    if raw_tracks is None:
        rel_tracks = raw_album.get("relationships", {}).get("tracks", {}).get("data")
        if isinstance(rel_tracks, list):
            raw_tracks = rel_tracks
        else:
            raw_tracks = []

    def track_sort_key(t):
        t_attrs = t.get("attributes") or {}
        d = t_attrs.get("discNumber") if t_attrs.get("discNumber") is not None else t.get("discNumber", 1)
        tr = t_attrs.get("trackNumber") if t_attrs.get("trackNumber") is not None else t.get("trackNumber", 1)
        try:
            d_int = int(d)
        except (ValueError, TypeError):
            d_int = 1
        try:
            tr_int = int(tr)
        except (ValueError, TypeError):
            tr_int = 1
        return (d_int, tr_int)

    sorted_tracks = sorted(raw_tracks, key=track_sort_key)

    # Group raw tracks by discNumber first, so each group's tracks are
    # indexed from 0 within that group (a group is played on its own, so
    # "index" is the position in *that* group's queue, not the whole album).
    raw_discs: dict[int, list[dict]] = {}
    for t in sorted_tracks:
        t_attrs = t.get("attributes") or {}
        d = t_attrs.get("discNumber") if t_attrs.get("discNumber") is not None else t.get("discNumber", 1)
        try:
            d_int = int(d) if d is not None else 1
        except (ValueError, TypeError):
            d_int = 1
        raw_discs.setdefault(d_int, []).append(t)

    normalized_tracks = []
    groups = []
    for d in sorted(raw_discs.keys()):
        disc_label = f"Disc {d if d > 0 else 1}"
        disc_entries = [
            normalize_track(t, index=idx)
            for idx, t in enumerate(raw_discs[d])
        ]
        normalized_tracks.extend(disc_entries)
        groups.append({
            "name": disc_label,
            "play": {"kind": "album", "id": item_id},
            "entries": disc_entries,
        })

    song_count = len(normalized_tracks)
    total_duration_ms = sum(t["durationMs"] for t in normalized_tracks)
    if song_count == 0 and attrs.get("trackCount"):
        try:
            song_count = int(attrs["trackCount"])
        except (ValueError, TypeError):
            song_count = 0

    count_label = format_count_label(song_count, total_duration_ms)

    content_rating = attrs.get("contentRating") or raw_album.get("contentRating")
    is_explicit = (
        content_rating == "explicit"
        or attrs.get("explicit") is True
        or raw_album.get("explicit") is True
        or any(t.get("explicit") for t in normalized_tracks)
    )

    return {
        "id": item_id,
        "kind": "album",
        "title": title,
        "subtitle": subtitle,
        "year": year,
        "genre": genre,
        "summary": summary,
        "art": art,
        "artColor": art_color,
        "countLabel": count_label,
        "explicit": is_explicit,
        "catalogId": catalog_id,
        "url": url,
        "play": {"kind": "album", "id": item_id},
        "groups": groups,
    }


def normalize_artist(
    raw_artist: dict,
    albums_or_cache_dir=None,
    cache_dir: str | None = None,
    albums: list[dict] | None = None,
) -> dict:
    """Turn an Apple Music API artist into the AGENTS.md Item shape with kind='artist'.

    Supports both signatures:
      normalize_artist(raw_artist, albums=None, cache_dir=None)
      normalize_artist(raw_artist, cache_dir=None, albums=None)
    subtitle='Artist', groups=[one group per album].
    """
    if isinstance(albums_or_cache_dir, str):
        actual_cache_dir = albums_or_cache_dir
        actual_albums = albums
    else:
        actual_albums = albums if albums is not None else (albums_or_cache_dir if isinstance(albums_or_cache_dir, list) else None)
        actual_cache_dir = cache_dir

    attrs = raw_artist.get("attributes") or {}
    item_id = str(raw_artist.get("id") or "")
    title = attrs.get("name") or raw_artist.get("title") or ""
    subtitle = "Artist"
    year = None

    genre_names = attrs.get("genreNames") or raw_artist.get("genreNames")
    genre = None
    if isinstance(genre_names, list) and len(genre_names) > 0:
        genre = genre_names[0]
    elif isinstance(genre_names, str):
        genre = genre_names
    elif raw_artist.get("genre"):
        genre = raw_artist["genre"]

    summary = _extract_summary(attrs, raw_artist)
    art, art_color = _extract_artwork(attrs, raw_artist, actual_cache_dir)
    catalog_id = _extract_catalog_id(attrs, raw_artist, "artists")
    url = attrs.get("url") or raw_artist.get("url")

    raw_albums = actual_albums
    if raw_albums is None:
        rel_albums = raw_artist.get("relationships", {}).get("albums", {}).get("data")
        if isinstance(rel_albums, list):
            raw_albums = rel_albums
        else:
            raw_albums = []

    groups = []
    has_explicit = False
    for alb in raw_albums:
        if alb.get("kind") == "album" and "groups" in alb and "play" in alb:
            all_entries = []
            for g in alb.get("groups", []):
                all_entries.extend(g.get("entries", []))
            groups.append({
                "name": alb.get("title", ""),
                "play": alb.get("play", {"kind": "album", "id": alb.get("id")}),
                "entries": all_entries,
            })
            if alb.get("explicit"):
                has_explicit = True
        else:
            norm_alb = normalize_album(alb, cache_dir=actual_cache_dir)
            all_entries = []
            for g in norm_alb.get("groups", []):
                all_entries.extend(g.get("entries", []))
            groups.append({
                "name": norm_alb.get("title", ""),
                "play": norm_alb.get("play", {"kind": "album", "id": norm_alb.get("id")}),
                "entries": all_entries,
            })
            if norm_alb.get("explicit"):
                has_explicit = True

    album_count = len(groups)
    count_label = f"{album_count} album" if album_count == 1 else f"{album_count} albums"

    return {
        "id": item_id,
        "kind": "artist",
        "title": title,
        "subtitle": subtitle,
        "year": year,
        "genre": genre,
        "summary": summary,
        "art": art,
        "artColor": art_color,
        "countLabel": count_label,
        "explicit": has_explicit,
        "catalogId": catalog_id,
        "url": url,
        "play": {"kind": "artist", "id": item_id},
        "groups": groups,
    }


def normalize_playlist(
    raw_playlist: dict,
    tracks_or_cache_dir=None,
    cache_dir: str | None = None,
    tracks: list[dict] | None = None,
) -> dict:
    """Turn an Apple Music API playlist into the AGENTS.md Item shape with kind='playlist'.

    Supports both signatures:
      normalize_playlist(raw_playlist, tracks=None, cache_dir=None)
      normalize_playlist(raw_playlist, cache_dir=None, tracks=None)
    groups=[{"name": "Playlist", "play": {"kind": "playlist", "id": item_id}, "entries": [...]}]
    """
    if isinstance(tracks_or_cache_dir, str):
        actual_cache_dir = tracks_or_cache_dir
        actual_tracks = tracks
    else:
        actual_tracks = tracks if tracks is not None else (tracks_or_cache_dir if isinstance(tracks_or_cache_dir, list) else None)
        actual_cache_dir = cache_dir

    attrs = raw_playlist.get("attributes") or {}
    item_id = str(raw_playlist.get("id") or "")
    title = attrs.get("name") or raw_playlist.get("title") or ""
    subtitle = (
        attrs.get("curatorName")
        or attrs.get("artistName")
        or raw_playlist.get("subtitle")
        or "Apple Music"
    )
    year = _extract_year(attrs, raw_playlist)

    genre_names = attrs.get("genreNames") or raw_playlist.get("genreNames")
    genre = None
    if isinstance(genre_names, list) and len(genre_names) > 0:
        genre = genre_names[0]
    elif isinstance(genre_names, str):
        genre = genre_names
    elif raw_playlist.get("genre"):
        genre = raw_playlist["genre"]

    summary = _extract_summary(attrs, raw_playlist)
    art, art_color = _extract_artwork(attrs, raw_playlist, actual_cache_dir)
    catalog_id = _extract_catalog_id(attrs, raw_playlist, "playlists")
    url = attrs.get("url") or raw_playlist.get("url")

    raw_tracks = actual_tracks
    if raw_tracks is None:
        rel_tracks = raw_playlist.get("relationships", {}).get("tracks", {}).get("data")
        if isinstance(rel_tracks, list):
            raw_tracks = rel_tracks
        else:
            raw_tracks = []

    normalized_tracks = [
        normalize_track(t, index=idx)
        for idx, t in enumerate(raw_tracks)
    ]

    groups = [
        {
            "name": "Tracks",
            "play": {"kind": "playlist", "id": item_id},
            "entries": normalized_tracks,
        }
    ]

    song_count = len(normalized_tracks)
    total_duration_ms = sum(t["durationMs"] for t in normalized_tracks)
    if song_count == 0 and attrs.get("trackCount"):
        try:
            song_count = int(attrs["trackCount"])
        except (ValueError, TypeError):
            song_count = 0

    count_label = format_count_label(song_count, total_duration_ms)

    content_rating = attrs.get("contentRating") or raw_playlist.get("contentRating")
    is_explicit = (
        content_rating == "explicit"
        or attrs.get("explicit") is True
        or raw_playlist.get("explicit") is True
        or any(t.get("explicit") for t in normalized_tracks)
    )

    return {
        "id": item_id,
        "kind": "playlist",
        "title": title,
        "subtitle": subtitle,
        "year": year,
        "genre": genre,
        "summary": summary,
        "art": art,
        "artColor": art_color,
        "countLabel": count_label,
        "explicit": is_explicit,
        "catalogId": catalog_id,
        "url": url,
        "play": {"kind": "playlist", "id": item_id},
        "groups": groups,
    }


def normalize_station(raw_station: dict, cache_dir: str | None = None) -> dict:
    """Turn an Apple Music API station into the AGENTS.md Item shape with kind='station'.

    groups=[]
    """
    attrs = raw_station.get("attributes") or {}
    item_id = str(raw_station.get("id") or "")
    title = attrs.get("name") or raw_station.get("title") or ""
    subtitle = (
        attrs.get("stationProviderName")
        or attrs.get("curatorName")
        or attrs.get("artistName")
        or raw_station.get("subtitle")
        or "Apple Music Radio"
    )
    year = None

    genre_names = attrs.get("genreNames") or raw_station.get("genreNames")
    genre = None
    if isinstance(genre_names, list) and len(genre_names) > 0:
        genre = genre_names[0]
    elif isinstance(genre_names, str):
        genre = genre_names
    elif raw_station.get("genre"):
        genre = raw_station["genre"]

    summary = _extract_summary(attrs, raw_station)
    art, art_color = _extract_artwork(attrs, raw_station, cache_dir)
    catalog_id = _extract_catalog_id(attrs, raw_station, "stations")
    url = attrs.get("url") or raw_station.get("url")

    content_rating = attrs.get("contentRating") or raw_station.get("contentRating")
    is_explicit = (
        content_rating == "explicit"
        or attrs.get("explicit") is True
        or raw_station.get("explicit") is True
    )

    return {
        "id": item_id,
        "kind": "station",
        "title": title,
        "subtitle": subtitle,
        "year": year,
        "genre": genre,
        "summary": summary,
        "art": art,
        "artColor": art_color,
        "countLabel": None,
        "explicit": is_explicit,
        "catalogId": catalog_id,
        "url": url,
        "play": {"kind": "station", "id": item_id},
        "groups": [],
    }


def normalize_song_as_item(raw_song: dict, cache_dir: str | None = None) -> dict:
    """Normalize an Apple Music song into the Item shape (e.g. for search results)."""
    attrs = raw_song.get("attributes") or {}
    item_id = str(raw_song.get("id") or "")
    catalog_id = _extract_catalog_id(attrs, raw_song, "songs")

    art, art_color = _extract_artwork(attrs, raw_song, cache_dir)
    duration_ms = attrs.get("durationInMillis") if attrs.get("durationInMillis") is not None else raw_song.get("durationMs", 0)
    try:
        duration_ms = int(duration_ms)
    except (ValueError, TypeError):
        duration_ms = 0

    year = _extract_year(attrs, raw_song)
    genre_names = attrs.get("genreNames") or raw_song.get("genreNames")
    genre = genre_names[0] if isinstance(genre_names, list) and genre_names else None

    return {
        "id": item_id,
        "kind": "song",
        "title": attrs.get("name") or raw_song.get("title") or "",
        "subtitle": attrs.get("artistName") or raw_song.get("artist") or "",
        "year": year,
        "genre": genre,
        "summary": None,
        "art": art,
        "artColor": art_color,
        "countLabel": format_duration(duration_ms),
        "explicit": attrs.get("contentRating") == "explicit" or attrs.get("explicit") is True,
        "catalogId": catalog_id,
        "url": attrs.get("url") or raw_song.get("url"),
        "play": {"kind": "song", "id": item_id},
        "groups": [],
    }


def normalize_item(raw_item: dict, cache_dir: str | None = None, include_groups: bool = True) -> dict:
    """Normalize any Apple Music resource into an Item."""
    raw_type = str(raw_item.get("type", ""))
    raw_kind = str(raw_item.get("kind", ""))

    if raw_type in ("albums", "library-albums") or raw_kind == "album":
        item = normalize_album(raw_item, cache_dir=cache_dir)
    elif raw_type in ("playlists", "library-playlists") or raw_kind == "playlist":
        item = normalize_playlist(raw_item, cache_dir=cache_dir)
    elif raw_type in ("artists", "library-artists") or raw_kind == "artist":
        item = normalize_artist(raw_item, cache_dir=cache_dir)
    elif raw_type in ("stations", "radio-stations", "apple-curators") or raw_kind == "station":
        item = normalize_station(raw_item, cache_dir=cache_dir)
    elif raw_type in ("songs", "library-songs", "music-videos") or raw_kind == "song":
        item = normalize_song_as_item(raw_item, cache_dir=cache_dir)
    else:
        attrs = raw_item.get("attributes") or {}
        if "trackCount" in attrs or "artistName" in attrs:
            item = normalize_album(raw_item, cache_dir=cache_dir)
        else:
            item = normalize_station(raw_item, cache_dir=cache_dir)

    if not include_groups:
        item["groups"] = []
    return item


def normalize_shelf_item(raw_item: dict, cache_dir: str | None = None) -> dict:
    """Normalize a single shelf item by inferring its kind/type."""
    if (
        isinstance(raw_item, dict)
        and raw_item.get("kind") in ("album", "playlist", "artist", "station")
        and "groups" in raw_item
        and "play" in raw_item
    ):
        return raw_item

    return normalize_item(raw_item, cache_dir=cache_dir, include_groups=True)


def normalize_shelf(
    key: str,
    title: str,
    raw_items: list[dict],
    cache_dir: str | None = None,
) -> dict:
    """Turn a list of raw shelf items into a shelf object.

    Returns {"key": key, "title": title, "items": [Item, ...]}.
    """
    items = []
    for item in raw_items:
        if isinstance(item, dict):
            items.append(normalize_shelf_item(item, cache_dir=cache_dir))

    return {
        "key": key,
        "title": title,
        "items": items,
    }


def group_songs_into_albums_and_artists(songs: list[dict], cache_dir: str | None = None) -> tuple[list[dict], list[dict]]:
    """Group songs from /v1/me/library/songs?include=albums into albums and artists."""
    albums_map: dict[str, dict] = {}
    for s in songs:
        s_attrs = s.get("attributes") or {}
        album_name = s_attrs.get("albumName", "Unknown Album")
        artist_name = s_attrs.get("artistName", "Unknown Artist")

        rel_albums = s.get("relationships", {}).get("albums", {}).get("data", [])
        if rel_albums:
            alb_rel = rel_albums[0]
            alb_id = alb_rel.get("id")
            alb_obj = alb_rel
        else:
            alb_id = f"l.alb_{hashlib.md5(f'{album_name}:{artist_name}'.encode('utf-8')).hexdigest()[:12]}"
            alb_obj = {
                "id": alb_id,
                "type": "library-albums",
                "attributes": {
                    "name": album_name,
                    "artistName": artist_name,
                    "artwork": s_attrs.get("artwork"),
                    "releaseDate": s_attrs.get("releaseDate"),
                    "genreNames": s_attrs.get("genreNames", []),
                    "contentRating": s_attrs.get("contentRating"),
                },
            }

        if alb_id not in albums_map:
            albums_map[alb_id] = {
                "album": alb_obj,
                "songs": [],
            }
        albums_map[alb_id]["songs"].append(s)

    albums_list = []
    artists_map: dict[str, list[dict]] = {}
    for alb_id, entry in albums_map.items():
        alb_norm = normalize_album(entry["album"], cache_dir=cache_dir, tracks=entry["songs"])
        albums_list.append(alb_norm)

        art_name = alb_norm["subtitle"] or "Unknown Artist"
        artists_map.setdefault(art_name, []).append(alb_norm)

    albums_list.sort(key=lambda a: a.get("title", "").lower())

    artists_list = []
    for art_name, art_albums in sorted(artists_map.items(), key=lambda x: x[0].lower()):
        art_id = f"l.art_{hashlib.md5(art_name.encode('utf-8')).hexdigest()[:12]}"
        first_art = art_albums[0]["art"] if art_albums and art_albums[0].get("art") else None
        first_color = art_albums[0].get("artColor") if art_albums else None

        art_obj = {
            "id": art_id,
            "type": "library-artists",
            "attributes": {
                "name": art_name,
                "genreNames": [art_albums[0].get("genre")] if art_albums and art_albums[0].get("genre") else [],
            },
        }
        artist_norm = normalize_artist(art_obj, cache_dir=cache_dir, albums=art_albums)
        if not artist_norm["art"]:
            artist_norm["art"] = first_art
            artist_norm["artColor"] = first_color
        artists_list.append(artist_norm)

    return albums_list, artists_list


def build_library_json(storefront: str, sections: dict, shelves: list) -> dict:
    """Build the complete library.json structure adhering to the AGENTS.md schema."""
    clean_sections = {
        "albums": sections.get("albums", []),
        "artists": sections.get("artists", []),
        "playlists": sections.get("playlists", []),
        "radio": sections.get("radio", []),
    }
    for k, v in sections.items():
        if k not in clean_sections:
            clean_sections[k] = v

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "version": 1,
        "generated": now_iso,
        "storefront": storefront,
        "sections": clean_sections,
        "shelves": list(shelves),
    }


def save_library(library_data: dict, cache_dir: str, only: str | None = None) -> None:
    """Atomically save library.json under flock, merging sections if only is specified."""
    os.makedirs(cache_dir, exist_ok=True)
    lock_path = os.path.join(cache_dir, "library.lock")
    lib_path = os.path.join(cache_dir, "library.json")

    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            target_data = library_data
            if only and os.path.exists(lib_path):
                try:
                    with open(lib_path, "r", encoding="utf-8") as f:
                        existing = json.load(f)
                    if only in ("albums", "artists", "playlists", "radio"):
                        existing.setdefault("sections", {})[only] = library_data.get("sections", {}).get(only, [])
                    elif only == "shelves":
                        existing["shelves"] = library_data.get("shelves", [])
                    existing["generated"] = library_data.get("generated", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
                    target_data = existing
                except Exception:
                    target_data = library_data

            tmp_path = lib_path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(target_data, f, indent=2)
            os.replace(tmp_path, lib_path)
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
