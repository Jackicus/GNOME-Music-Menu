# The backend

Everything that talks to Apple Music lives here. The shell process never
touches the network: `src/lib/amctl.js` spawns `am.py <command>`, reads the
one JSON object it prints, and otherwise only reads files this code wrote.

```
Extension (src/lib, in the shell) ──spawn──► am.py <command> ──CDP──► Chrome: music.apple.com
        ▲  reads ~/.cache/music-menu/library.json + art/   (one-shot, JSON on stdout)     │
        └──────────────── MPRIS (org.mpris.MediaPlayer2.chrome.*) ◄──────────────────────┘
```

- **`am.py`** — the CLI. Every command prints one JSON object and exits 0,
  or `{"error": "<code>", "message": "…"}` and exits 1. Error codes:
  `engine-down`, `not-signed-in`, `api`, `timeout`, `usage`. Failures worth
  a note go to stderr, prefixed `am.py:`.
- **`cdp.py`** — a Chrome DevTools Protocol client on the standard library
  alone (its own WebSocket framing). Nothing here needs pip.
- **`bridge.js`** — the only code that runs inside the page. Injected
  idempotently, it defines `window.__musicMenu` over the page's own
  `MusicKit` instance; `am.py`'s commands are thin calls into it.
- **`sync.py`** — pure functions turning API responses into the `Item` and
  `Track` shapes below, plus the artwork cache. Unit tested in `tests/`.

## The engine

The engine is Google Chrome (the real build: it ships Widevine, Chromium
doesn't) running music.apple.com in a profile of its own, with the
debugging port on 127.0.0.1. The user signs in once in a visible window;
after that it runs headless. Its state is
`$XDG_RUNTIME_DIR/music-menu/engine.json`: `{pid, port, headless, profile,
started}`, which `player.js` reads to pick Chrome's MPRIS player out of the
bus by PID.

The page exposes MusicKit v3 as a global, and that is all the bridge uses:
`mk.api.music(path, params)` for the API, `mk.setQueue({album|playlist|
station|song|songs, startWith, startPlaying})` and `mk.play()` for
playback, `mk.playNext`/`mk.playLater`, `mk.shuffleMode`/`mk.repeatMode`,
and `mk.isAuthorized`/`mk.storefrontId`. API failures come back as a 200
with `{"errors": [...]}`, which `am.py` treats as a failure and retries.

Every command starts the engine headless if it is not running, unless
`--no-start` is given (`status` never starts it).

| Command | Result |
|---|---|
| `engine start [--visible\|--headless]`, `engine stop`, `engine status` | `{running, pid, port, headless}` |
| `signin` | Restarts the engine visible at music.apple.com and calls `mk.authorize()`. `{authorized}` |
| `status` | `{engine, authorized, storefront, bitrate}` |
| `sync [--only albums\|artists\|playlists\|radio\|shelves]` | Writes library.json (merged per section, under `flock`) and fetches missing artwork in threads. `{counts, generated}` |
| `item <kind> <id>` | One full item with its `groups`, for a shelf or search result picked on demand; fetches its artwork too |
| `play <kind> <id> [--start-with N] [--shuffle]` | `{ok: true}`. kind ∈ `album playlist station song artist` |
| `play-next <kind> <id>`, `play-later <kind> <id>` | `{ok: true}` |
| `control play\|pause\|toggle\|next\|previous\|stop`, `seek <sec>`, `volume <0..1>` | `{ok: true}` |
| `shuffle on\|off\|toggle`, `repeat none\|one\|all\|cycle` | `{shuffle, repeat}` |
| `now-playing` | `{state, track, position, duration, shuffle, repeat, volume}` |
| `queue` | `{index, items: [Track…]}` |
| `love\|unlove <kind> <id>`, `add-to-library <kind> <id>` | `{ok: true}` |
| `playlists`, `add-to-playlist <playlistId> <songId>` | `{items: [{id, title}]}`, `{ok: true}` |
| `lyrics <catalogSongId>` | `{synced, lines: [{startMs, endMs, text}]}`, cached under `<cache>/lyrics/` |
| `search <term> [--library] [--limit N]` | `{items: [Item without groups]}` |

## `library.json`

`~/.cache/music-menu/library.json` is written only by `am.py sync` (or by
`scripts/demo_library.py` for demos and tests) and read only by
`src/lib/library.js`.

```jsonc
{
  "version": 1, "generated": "2026-09-25T12:00:00Z", "storefront": "us",
  "sections": {"albums": [Item], "artists": [Item], "playlists": [Item], "radio": [Item]},
  "shelves": [{"key": "heavy-rotation", "title": "Heavy Rotation", "items": [Item]},
              {"key": "recently-added", …}, {"key": "recently-played", …}, {"key": "made-for-you", …}]
}

Item = {
  "id": "l.abc123",             // library id, or catalog id when not in the library
  "kind": "album" | "playlist" | "artist" | "station",
  "title": "…", "subtitle": "…",                 // artist, curator, or "Apple Music"
  "year": 2007, "genre": "Rock", "summary": "plain text" /* or null */,
  "art": "<cache>/art/<sha1>.jpg" /* or null */, "artColor": "#1a1a1a" /* or null */,
  "countLabel": "12 songs, 43 min", "explicit": false,
  "catalogId": "…" /* or null */, "url": "https://music.apple.com/…" /* or null */,
  "play": {"kind": "album", "id": "l.abc123"},   // what `am.py play` gets
  "groups": [{"name": "Disc 1", "play": {"kind": "album", "id": "l.abc123"}, "entries": [Track]}]
                                                  // artists: one group per album; stations and
                                                  // shelf items: [] until `am.py item` fills them
}
Track = {"id": "i.xyz", "catalogId": "…" /* or null */, "title": "…", "artist": "…", "album": "…",
         "trackNumber": 1, "discNumber": 1, "durationMs": 216000, "durationLabel": "3:36",
         "explicit": true, "index": 0}            // index = position in group.play's queue
```

Artwork is fetched at 512×512 into `<cache>/art/`; a path that is not on
disk counts as no artwork. A track row plays `group.play` with
`--start-with entry.index`.

## Keeping tests and dev runs off the real profile

| Variable | Overrides |
|---|---|
| `MUSIC_MENU_PROFILE` | Chrome's profile directory (default `$XDG_DATA_HOME/music-menu/chrome`) |
| `MUSIC_MENU_PORT` | the debugging port (default: the `engine-port` setting, 9227) |
| `MUSIC_MENU_CACHE` | the cache directory (default `~/.cache/music-menu`) |

```bash
python3 -m unittest discover -s tests -v   # the backend's tests
./scripts/check.sh                          # those plus JS syntax, the schema and py_compile
```
