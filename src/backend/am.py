#!/usr/bin/env python3
"""Apple Music CLI driver for Music Menu GNOME Shell extension.

Every command prints ONE JSON object on stdout and exits 0.
On failure prints {"error": "<code>", "message": "..."} and exits 1.
Error codes: engine-down, not-signed-in, api, timeout, usage.
"""

from datetime import datetime, timezone
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Ensure backend directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp import CDPClient, connect_to_chrome
import sync


class AmError(Exception):
    """Custom error matching the Music Menu error contract."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = str(message)


# ---------------------------------------------------------------------------
# Path & Environment Resolution
# ---------------------------------------------------------------------------


def get_cache_dir():
    if os.environ.get("MUSIC_MENU_CACHE"):
        return os.path.abspath(os.environ["MUSIC_MENU_CACHE"])
    xdg = os.environ.get("XDG_CACHE_HOME")
    if xdg:
        return os.path.join(xdg, "music-menu")
    return os.path.expanduser("~/.cache/music-menu")


def get_profile_dir():
    if os.environ.get("MUSIC_MENU_PROFILE"):
        return os.path.abspath(os.environ["MUSIC_MENU_PROFILE"])
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return os.path.join(xdg, "music-menu", "chrome")
    return os.path.expanduser("~/.local/share/music-menu/chrome")


def get_state_file():
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        d = os.path.join(xdg, "music-menu")
    else:
        uid = os.getuid()
        d = f"/tmp/music-menu-{uid}"
    return os.path.join(d, "engine.json")


def get_settings():
    try:
        from gi.repository import Gio

        source = Gio.SettingsSchemaSource.get_default()
        if source and source.lookup("org.gnome.shell.extensions.music-menu", True):
            return Gio.Settings.new("org.gnome.shell.extensions.music-menu")
    except Exception:
        pass
    return None


def get_setting(key, fallback=None):
    defaults = {
        "browser-command": "google-chrome-stable",
        "engine-port": 9227,
        "engine-headless": True,
        "engine-autostart": True,
        "sync-interval": 60,
        "player-bar": True,
        "last-sync": "",
    }
    settings = get_settings()
    if settings is not None:
        try:
            if key in ("engine-port", "sync-interval"):
                return settings.get_int(key)
            elif key in ("engine-headless", "engine-autostart", "player-bar"):
                return settings.get_boolean(key)
            elif key in ("browser-command", "last-sync"):
                return settings.get_string(key)
        except Exception:
            pass
    return defaults.get(key, fallback)


def set_setting(key, value):
    settings = get_settings()
    if settings is not None:
        try:
            if isinstance(value, str):
                settings.set_string(key, value)
            elif isinstance(value, bool):
                settings.set_boolean(key, value)
            elif isinstance(value, int):
                settings.set_int(key, value)
        except Exception:
            pass


def get_port():
    env_port = os.environ.get("MUSIC_MENU_PORT")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            pass
    return get_setting("engine-port", 9227)


# ---------------------------------------------------------------------------
# Engine Process Management
# ---------------------------------------------------------------------------


def is_pid_running(pid):
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def get_state():
    state_file = get_state_file()
    if not os.path.exists(state_file):
        return None
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(state):
    state_file = get_state_file()
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    tmp_path = state_file + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp_path, state_file)


def remove_state():
    state_file = get_state_file()
    if os.path.exists(state_file):
        try:
            os.remove(state_file)
        except OSError:
            pass


def is_port_responding(port, timeout=1):
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/json",
            headers={"User-Agent": "MusicMenu/1.0"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def engine_status():
    state = get_state()
    port = get_port()
    headless = get_setting("engine-headless", True)
    if state:
        pid = state.get("pid")
        port = state.get("port", port)
        headless = state.get("headless", headless)
        if is_pid_running(pid) and is_port_responding(port):
            return {"running": True, "pid": pid, "port": port, "headless": headless}
    return {"running": False, "pid": None, "port": port, "headless": headless}


def engine_stop():
    state = get_state()
    port = get_port()
    headless = get_setting("engine-headless", True)
    if state:
        pid = state.get("pid")
        port = state.get("port", port)
        headless = state.get("headless", headless)
        if pid and is_pid_running(pid):
            try:
                os.kill(pid, signal.SIGTERM)
                for _ in range(30):
                    time.sleep(0.1)
                    if not is_pid_running(pid):
                        break
                if is_pid_running(pid):
                    os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    remove_state()
    return {"running": False, "pid": None, "port": port, "headless": headless}


def ensure_bridge(client, timeout=15):
    """Inject bridge.js into page and poll until MusicKit is ready."""
    bridge_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.js")
    with open(bridge_path, "r", encoding="utf-8") as f:
        bridge_code = f.read()

    # Idempotent injection
    client.evaluate(bridge_code, await_promise=False)

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            st = client.evaluate("window.__musicMenu ? window.__musicMenu.status() : null")
            if st and st.get("ready"):
                return
        except Exception:
            pass
        time.sleep(0.2)


def engine_start(headless=None):
    if headless is None:
        headless = get_setting("engine-headless", True)

    curr = engine_status()
    if curr["running"]:
        if curr["headless"] == headless:
            try:
                client = connect_to_chrome(curr["port"], timeout=5)
                try:
                    ensure_bridge(client, timeout=15)
                finally:
                    client.close()
            except Exception:
                pass
            return curr
        else:
            engine_stop()

    browser_cmd = get_setting("browser-command", "google-chrome-stable")
    browser_bin = shutil.which(browser_cmd)
    if not browser_bin:
        for candidate in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
            b = shutil.which(candidate)
            if b:
                browser_bin = b
                break
    if not browser_bin:
        raise AmError("engine-down", f"Browser command not found: {browser_cmd}")

    profile_dir = get_profile_dir()
    os.makedirs(profile_dir, exist_ok=True)
    port = get_port()

    args = [
        browser_bin,
        f"--user-data-dir={profile_dir}",
        f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        args.append("--headless=new")
        args.append("https://music.apple.com/")
    else:
        args.append("--app=https://music.apple.com/")

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        raise AmError("engine-down", f"Failed to start Chrome: {e}")

    state = {
        "pid": proc.pid,
        "port": port,
        "headless": headless,
        "profile": profile_dir,
        "started": int(time.time()),
    }
    save_state(state)

    try:
        client = connect_to_chrome(port, timeout=15)
    except Exception as e:
        engine_stop()
        raise AmError("timeout", f"Timed out connecting to Chrome: {e}")

    try:
        ensure_bridge(client, timeout=15)
    finally:
        client.close()

    return {"running": True, "pid": proc.pid, "port": port, "headless": headless}


def ensure_engine_running(no_start=False):
    st = engine_status()
    if st["running"]:
        return st
    if no_start:
        raise AmError("engine-down", "Chrome engine is not running and --no-start was passed")
    if not get_setting("engine-autostart", True):
        raise AmError("engine-down", "Chrome engine is not running and autostart is disabled")
    return engine_start(headless=True)


def get_bridge_client(no_start=False):
    st = ensure_engine_running(no_start=no_start)
    port = st["port"]
    try:
        client = connect_to_chrome(port, timeout=15)
    except Exception as e:
        raise AmError("engine-down", f"Could not connect to Chrome on port {port}: {e}")
    ensure_bridge(client, timeout=15)
    return client


# ---------------------------------------------------------------------------
# Command Handlers
# ---------------------------------------------------------------------------


def handle_signin():
    engine_stop()
    engine_start(headless=False)
    port = get_port()
    try:
        client = connect_to_chrome(port, timeout=15)
    except Exception as e:
        raise AmError("timeout", f"Failed to connect to visible Chrome: {e}")

    try:
        ensure_bridge(client, timeout=15)
        res = client.evaluate("window.__musicMenu.signin()", await_promise=True, timeout=120)
        auth = bool(res.get("authorized")) if isinstance(res, dict) else False
        return {"authorized": auth}
    finally:
        client.close()


def handle_status(no_start=True):
    st = engine_status()
    if not st["running"]:
        return {"engine": False, "authorized": False, "storefront": "", "bitrate": 0}

    try:
        client = connect_to_chrome(st["port"], timeout=5)
        try:
            ensure_bridge(client, timeout=5)
            res = client.evaluate("window.__musicMenu.status()")
            return {
                "engine": True,
                "authorized": bool(res.get("authorized")),
                "storefront": str(res.get("storefront", "us")),
                "bitrate": int(res.get("bitrate", 256)),
            }
        finally:
            client.close()
    except Exception:
        return {"engine": False, "authorized": False, "storefront": "", "bitrate": 0}


def handle_sync(only=None, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        st = client.evaluate("window.__musicMenu.status()")
        if not st or not st.get("authorized"):
            raise AmError("not-signed-in", "User is not signed in to Apple Music")

        cache_dir = get_cache_dir()
        counts = {"albums": 0, "artists": 0, "playlists": 0, "radio": 0, "shelves": 0}
        sections = {}
        shelves = []

        # 1. Albums & Artists from songs
        if not only or only in ("albums", "artists"):
            songs = []
            offset = 0
            while True:
                expr = f"window.__musicMenu.api('/v1/me/library/songs', {{include: 'albums', limit: 100, offset: {offset}}})"
                try:
                    res = client.evaluate(expr, await_promise=True)
                except Exception as e:
                    raise AmError("api", f"Failed to fetch library songs: {e}")
                data = res.get("data", []) if res else []
                if not data:
                    break
                songs.extend(data)
                if "next" not in res or len(data) < 100:
                    break
                offset += len(data)

            albums, artists = sync.group_songs_into_albums_and_artists(songs, cache_dir)
            sections["albums"] = albums
            sections["artists"] = artists
            counts["albums"] = len(albums)
            counts["artists"] = len(artists)

        # 2. Playlists
        if not only or only == "playlists":
            expr = "window.__musicMenu.api('/v1/me/library/playlists', {limit: 100})"
            try:
                res = client.evaluate(expr, await_promise=True)
                raw_playlists = res.get("data", []) if res else []
            except Exception as e:
                raise AmError("api", f"Failed to fetch library playlists: {e}")

            playlists = []
            for p in raw_playlists:
                p_id = p.get("id")
                t_expr = f"window.__musicMenu.api('/v1/me/library/playlists/{p_id}/tracks', {{limit: 100}})"
                try:
                    t_res = client.evaluate(t_expr, await_promise=True)
                    tracks = t_res.get("data", []) if t_res else []
                except Exception:
                    tracks = []
                p_norm = sync.normalize_playlist(p, cache_dir, tracks=tracks)
                playlists.append(p_norm)
            sections["playlists"] = playlists
            counts["playlists"] = len(playlists)

        # 3. Radio
        if not only or only == "radio":
            expr = "window.__musicMenu.api('/v1/me/recent/radio-stations')"
            try:
                res = client.evaluate(expr, await_promise=True)
                raw_stations = res.get("data", []) if res else []
            except Exception:
                raw_stations = []
            radio = [sync.normalize_station(st_obj, cache_dir) for st_obj in raw_stations]
            sections["radio"] = radio
            counts["radio"] = len(radio)

        # 4. Shelves
        if not only or only == "shelves":
            shelf_defs = [
                ("heavy-rotation", "Heavy Rotation", "/v1/me/history/heavy-rotation"),
                ("recently-added", "Recently Added", "/v1/me/library/recently-added"),
                ("recently-played", "Recently Played", "/v1/me/recent/played"),
                ("made-for-you", "Made for You", "/v1/me/recommendations"),
            ]
            for key, title, endpoint in shelf_defs:
                items = []
                try:
                    res = client.evaluate(f"window.__musicMenu.api('{endpoint}', {{limit: 25}})", await_promise=True)
                    raw_items = res.get("data", []) if res else []
                    if key == "made-for-you":
                        for rec in raw_items:
                            rec_items = rec.get("relationships", {}).get("contents", {}).get("data", [])
                            for it in rec_items:
                                items.append(sync.normalize_item(it, cache_dir, include_groups=False))
                    else:
                        for it in raw_items:
                            items.append(sync.normalize_item(it, cache_dir, include_groups=False))
                except Exception:
                    pass
                shelves.append({"key": key, "title": title, "items": items})
            counts["shelves"] = sum(len(s["items"]) for s in shelves)

        now_iso = datetime.now(timezone.utc).isoformat()
        lib_data = {
            "version": 1,
            "generated": now_iso,
            "storefront": st.get("storefront", "us"),
            "sections": sections,
            "shelves": shelves,
        }
        sync.save_library(lib_data, cache_dir, only=only)
        sync.prune_art(lib_data, cache_dir)
        set_setting("last-sync", now_iso)

        return {"counts": counts, "generated": now_iso}
    finally:
        client.close()


def handle_item(kind, item_id, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        st = client.evaluate("window.__musicMenu.status()")
        sf = st.get("storefront", "us") if st else "us"
        cache_dir = get_cache_dir()

        is_lib = item_id.startswith("l.") or item_id.startswith("p.") or item_id.startswith("r.")
        if kind == "album":
            endpoint = f"/v1/me/library/albums/{item_id}?include=tracks,artists" if is_lib else f"/v1/catalog/{sf}/albums/{item_id}?include=tracks,artists"
        elif kind == "playlist":
            endpoint = f"/v1/me/library/playlists/{item_id}?include=tracks" if is_lib else f"/v1/catalog/{sf}/playlists/{item_id}?include=tracks"
        elif kind == "artist":
            endpoint = f"/v1/me/library/artists/{item_id}/albums?include=tracks" if is_lib else f"/v1/catalog/{sf}/artists/{item_id}/albums?include=tracks"
        elif kind == "station":
            endpoint = f"/v1/catalog/{sf}/stations/{item_id}"
        elif kind == "song":
            endpoint = f"/v1/me/library/songs/{item_id}" if is_lib else f"/v1/catalog/{sf}/songs/{item_id}"
        else:
            endpoint = f"/v1/catalog/{sf}/{kind}s/{item_id}"

        try:
            res = client.evaluate(f"window.__musicMenu.api({json.dumps(endpoint)})", await_promise=True)
        except Exception as e:
            raise AmError("api", f"API error fetching item {kind} {item_id}: {e}")

        data = res.get("data", []) if res else []
        if not data:
            raise AmError("api", f"Item not found: {kind} {item_id}")

        raw_obj = data[0]
        if kind == "artist":
            artist_obj = {
                "id": item_id,
                "type": "artists",
                "attributes": raw_obj.get("attributes", {}),
            }
            albums = data if raw_obj.get("type") in ("albums", "library-albums") else raw_obj.get("relationships", {}).get("albums", {}).get("data", [])
            return sync.normalize_artist(artist_obj, cache_dir, albums=albums)

        return sync.normalize_item(raw_obj, cache_dir, include_groups=True)
    finally:
        client.close()


def handle_play(kind, item_id, start_with=0, shuffle=False, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        opts = {"startWith": start_with, "shuffle": shuffle}
        expr = f"window.__musicMenu.play({json.dumps(kind)}, {json.dumps(item_id)}, {json.dumps(opts)})"
        client.evaluate(expr, await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Play failed: {e}")
    finally:
        client.close()


def handle_play_next(kind, item_id, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        expr = f"window.__musicMenu.playNext({json.dumps(kind)}, {json.dumps(item_id)})"
        client.evaluate(expr, await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Play next failed: {e}")
    finally:
        client.close()


def handle_play_later(kind, item_id, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        expr = f"window.__musicMenu.playLater({json.dumps(kind)}, {json.dumps(item_id)})"
        client.evaluate(expr, await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Play later failed: {e}")
    finally:
        client.close()


def handle_control(action, no_start=False):
    if action not in ("play", "pause", "toggle", "next", "previous", "stop"):
        raise AmError("usage", f"Invalid control action: {action}")
    client = get_bridge_client(no_start=no_start)
    try:
        client.evaluate(f"window.__musicMenu.control({json.dumps(action)})", await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Control {action} failed: {e}")
    finally:
        client.close()


def handle_seek(sec, no_start=False):
    try:
        val = float(sec)
    except ValueError:
        raise AmError("usage", f"Invalid seek seconds: {sec}")
    client = get_bridge_client(no_start=no_start)
    try:
        client.evaluate(f"window.__musicMenu.seek({val})", await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Seek failed: {e}")
    finally:
        client.close()


def handle_volume(val, no_start=False):
    try:
        vol = float(val)
        if not (0.0 <= vol <= 1.0):
            raise ValueError()
    except ValueError:
        raise AmError("usage", f"Volume must be a number between 0 and 1: {val}")
    client = get_bridge_client(no_start=no_start)
    try:
        client.evaluate(f"window.__musicMenu.volume({vol})", await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Volume change failed: {e}")
    finally:
        client.close()


def handle_shuffle(mode, no_start=False):
    if mode not in ("on", "off", "toggle"):
        raise AmError("usage", f"Invalid shuffle mode: {mode}")
    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate(f"window.__musicMenu.shuffle({json.dumps(mode)})", await_promise=True)
        return res if isinstance(res, dict) else {"shuffle": "off", "repeat": "none"}
    except Exception as e:
        raise AmError("api", f"Shuffle failed: {e}")
    finally:
        client.close()


def handle_repeat(mode, no_start=False):
    if mode not in ("none", "one", "all", "cycle"):
        raise AmError("usage", f"Invalid repeat mode: {mode}")
    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate(f"window.__musicMenu.repeat({json.dumps(mode)})", await_promise=True)
        return res if isinstance(res, dict) else {"shuffle": "off", "repeat": "none"}
    except Exception as e:
        raise AmError("api", f"Repeat failed: {e}")
    finally:
        client.close()


def handle_now_playing(no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate("window.__musicMenu.nowPlaying()")
        return res if isinstance(res, dict) else {
            "state": "stopped",
            "track": None,
            "position": 0,
            "duration": 0,
            "shuffle": "off",
            "repeat": "none",
            "volume": 1,
        }
    except Exception as e:
        raise AmError("api", f"Now playing failed: {e}")
    finally:
        client.close()


def handle_queue(no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate("window.__musicMenu.queue()")
        return res if isinstance(res, dict) else {"index": 0, "items": []}
    except Exception as e:
        raise AmError("api", f"Queue failed: {e}")
    finally:
        client.close()


def handle_love(kind, item_id, love=True, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        client.evaluate(f"window.__musicMenu.rating({json.dumps(kind)}, {json.dumps(item_id)}, {json.dumps(love)})", await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Rating failed: {e}")
    finally:
        client.close()


def handle_add_to_library(kind, item_id, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        client.evaluate(f"window.__musicMenu.addToLibrary({json.dumps(kind)}, {json.dumps(item_id)})", await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Add to library failed: {e}")
    finally:
        client.close()


def handle_playlists(no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate("window.__musicMenu.playlists()", await_promise=True)
        return res if isinstance(res, dict) else {"items": []}
    except Exception as e:
        raise AmError("api", f"Playlists failed: {e}")
    finally:
        client.close()


def handle_add_to_playlist(playlist_id, song_id, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        client.evaluate(f"window.__musicMenu.addToPlaylist({json.dumps(playlist_id)}, {json.dumps(song_id)})", await_promise=True)
        return {"ok": True}
    except Exception as e:
        raise AmError("api", f"Add to playlist failed: {e}")
    finally:
        client.close()


def handle_lyrics(song_id, no_start=False):
    cache_dir = get_cache_dir()
    lyrics_file = os.path.join(cache_dir, "lyrics", f"{song_id}.json")
    if os.path.exists(lyrics_file):
        try:
            with open(lyrics_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate(f"window.__musicMenu.lyrics({json.dumps(song_id)})", await_promise=True)
        if not isinstance(res, dict):
            res = {"synced": False, "lines": []}
        try:
            os.makedirs(os.path.dirname(lyrics_file), exist_ok=True)
            with open(lyrics_file, "w", encoding="utf-8") as f:
                json.dump(res, f, indent=2)
        except Exception:
            pass
        return res
    finally:
        client.close()


def handle_search(term, library=False, limit=20, no_start=False):
    client = get_bridge_client(no_start=no_start)
    try:
        res = client.evaluate(f"window.__musicMenu.search({json.dumps(term)}, {json.dumps(library)}, {int(limit)})", await_promise=True)
        cache_dir = get_cache_dir()
        items = []
        raw_results = res.get("results", {}) if res else {}
        for section_key, section_data in raw_results.items():
            if not isinstance(section_data, dict):
                continue
            for raw_item in section_data.get("data", []):
                items.append(sync.normalize_item(raw_item, cache_dir, include_groups=False))
        return {"items": items}
    except Exception as e:
        raise AmError("api", f"Search failed: {e}")
    finally:
        client.close()


# ---------------------------------------------------------------------------
# CLI Argument Parsing & Dispatch
# ---------------------------------------------------------------------------


def run_cli(argv):
    no_start = "--no-start" in argv
    args = [a for a in argv if a != "--no-start"]

    if not args:
        raise AmError("usage", "No command provided")

    cmd = args[0]

    if cmd == "engine":
        if len(args) < 2:
            raise AmError("usage", "engine requires a subcommand: start, stop, status")
        sub = args[1]
        if sub == "start":
            headless = None
            if "--visible" in args[2:]:
                headless = False
            elif "--headless" in args[2:]:
                headless = True
            return engine_start(headless=headless)
        elif sub == "stop":
            return engine_stop()
        elif sub == "status":
            return engine_status()
        else:
            raise AmError("usage", f"Unknown engine subcommand: {sub}")

    elif cmd == "signin":
        return handle_signin()

    elif cmd == "status":
        return handle_status(no_start=True)

    elif cmd == "sync":
        only = None
        if "--only" in args:
            idx = args.index("--only")
            if idx + 1 >= len(args):
                raise AmError("usage", "--only requires a section: albums, artists, playlists, radio, shelves")
            only = args[idx + 1]
            if only not in ("albums", "artists", "playlists", "radio", "shelves"):
                raise AmError("usage", f"Invalid section for --only: {only}")
        return handle_sync(only=only, no_start=no_start)

    elif cmd == "item":
        if len(args) < 3:
            raise AmError("usage", "item requires <kind> and <id>")
        kind, item_id = args[1], args[2]
        return handle_item(kind, item_id, no_start=no_start)

    elif cmd == "play":
        if len(args) < 3:
            raise AmError("usage", "play requires <kind> and <id>")
        kind, item_id = args[1], args[2]
        start_with = 0
        shuffle = False
        idx = 3
        while idx < len(args):
            if args[idx] == "--start-with":
                if idx + 1 >= len(args):
                    raise AmError("usage", "--start-with requires an index number")
                try:
                    start_with = int(args[idx + 1])
                except ValueError:
                    raise AmError("usage", f"Invalid index for --start-with: {args[idx + 1]}")
                idx += 2
            elif args[idx] == "--shuffle":
                shuffle = True
                idx += 1
            else:
                raise AmError("usage", f"Unexpected argument for play: {args[idx]}")
        return handle_play(kind, item_id, start_with=start_with, shuffle=shuffle, no_start=no_start)

    elif cmd == "play-next":
        if len(args) < 3:
            raise AmError("usage", "play-next requires <kind> and <id>")
        return handle_play_next(args[1], args[2], no_start=no_start)

    elif cmd == "play-later":
        if len(args) < 3:
            raise AmError("usage", "play-later requires <kind> and <id>")
        return handle_play_later(args[1], args[2], no_start=no_start)

    elif cmd == "control":
        if len(args) < 2:
            raise AmError("usage", "control requires an action: play, pause, toggle, next, previous, stop")
        return handle_control(args[1], no_start=no_start)

    elif cmd == "seek":
        if len(args) < 2:
            raise AmError("usage", "seek requires seconds")
        return handle_seek(args[1], no_start=no_start)

    elif cmd == "volume":
        if len(args) < 2:
            raise AmError("usage", "volume requires a value between 0 and 1")
        return handle_volume(args[1], no_start=no_start)

    elif cmd == "shuffle":
        if len(args) < 2:
            raise AmError("usage", "shuffle requires a mode: on, off, toggle")
        return handle_shuffle(args[1], no_start=no_start)

    elif cmd == "repeat":
        if len(args) < 2:
            raise AmError("usage", "repeat requires a mode: none, one, all, cycle")
        return handle_repeat(args[1], no_start=no_start)

    elif cmd == "now-playing":
        return handle_now_playing(no_start=no_start)

    elif cmd == "queue":
        return handle_queue(no_start=no_start)

    elif cmd == "love":
        if len(args) < 3:
            raise AmError("usage", "love requires <kind> and <id>")
        return handle_love(args[1], args[2], love=True, no_start=no_start)

    elif cmd == "unlove":
        if len(args) < 3:
            raise AmError("usage", "unlove requires <kind> and <id>")
        return handle_love(args[1], args[2], love=False, no_start=no_start)

    elif cmd == "add-to-library":
        if len(args) < 3:
            raise AmError("usage", "add-to-library requires <kind> and <id>")
        return handle_add_to_library(args[1], args[2], no_start=no_start)

    elif cmd == "playlists":
        return handle_playlists(no_start=no_start)

    elif cmd == "add-to-playlist":
        if len(args) < 3:
            raise AmError("usage", "add-to-playlist requires <playlistId> and <songId>")
        return handle_add_to_playlist(args[1], args[2], no_start=no_start)

    elif cmd == "lyrics":
        if len(args) < 2:
            raise AmError("usage", "lyrics requires <catalogSongId>")
        return handle_lyrics(args[1], no_start=no_start)

    elif cmd == "search":
        if len(args) < 2:
            raise AmError("usage", "search requires <term>")
        library = False
        limit = 20
        term_parts = []
        idx = 1
        while idx < len(args):
            if args[idx] == "--library":
                library = True
                idx += 1
            elif args[idx] == "--limit":
                if idx + 1 >= len(args):
                    raise AmError("usage", "--limit requires a number")
                try:
                    limit = int(args[idx + 1])
                except ValueError:
                    raise AmError("usage", f"Invalid limit: {args[idx + 1]}")
                idx += 2
            else:
                term_parts.append(args[idx])
                idx += 1
        term = " ".join(term_parts)
        if not term:
            raise AmError("usage", "search requires a search term")
        return handle_search(term, library=library, limit=limit, no_start=no_start)

    else:
        raise AmError("usage", f"Unknown command: {cmd}")


def main():
    try:
        res = run_cli(sys.argv[1:])
        print(json.dumps(res))
        sys.exit(0)
    except AmError as e:
        print(json.dumps({"error": e.code, "message": e.message}))
        sys.exit(1)
    except TimeoutError as e:
        print(json.dumps({"error": "timeout", "message": str(e)}))
        sys.exit(1)
    except Exception as e:
        msg = str(e)
        code = "api"
        if "connection refused" in msg.lower() or "engine" in msg.lower():
            code = "engine-down"
        print(json.dumps({"error": code, "message": msg}))
        sys.exit(1)


if __name__ == "__main__":
    main()
