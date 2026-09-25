# Music Menu

Music Menu (`music-menu@jackt`) is a GNOME Shell extension: the user's Apple
Music library as a menu beside Show Apps. It is a copy of its sibling
**Video Menu** (`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu`)
with the namespace renamed (`media-libraries` → `music-menu`,
`MediaLibraries*` → `MusicMenu*`, `ml-` → `mm-`) and its back end replaced.

**Video Menu's own `CLAUDE.md`** (absolute path:
`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu/CLAUDE.md`) still
describes every UI mechanism this tree inherited unchanged: the app grid
built on `BaseAppView`, the folder-dialog pop-up (`panel.js`/`MediaPanel`),
the desktop/workspace/menu/modal surface, focus handling and the keyboard,
the overview-preview clones, the chain-safe wraps for coexisting with another
extension, and the whole Design Rules and Gotchas sections (St is not the
web, no flexbox, no CSS variables, sizes in `em`, colour from
`-st-accent-color`, nothing blocks the compositor, nothing builds an actor
per item). Read it before touching anything under `src/lib/` that isn't
listed below as new. This file does not repeat it — it only documents what
Music Menu adds on top.

`src/backend/README.md` is the backend's reference: the `am.py` command
table, the `library.json` shape and the env overrides. This file is the
shorter orientation for whoever picks the code up next.

## What's new: the engine

There is no paid API and no third-party client. The **engine** is Google
Chrome running music.apple.com in its own profile, with the DevTools
protocol (CDP) enabled, driving Apple's own **MusicKit** web player — the
same object the page itself uses.

```
Extension (src/lib, in the shell) ──spawn──► src/backend/am.py <command> ──CDP──► Chrome: music.apple.com
        ▲  reads ~/.cache/music-menu/library.json + art/     (one-shot, JSON on stdout)      │
        └──────────────── MPRIS (org.mpris.MediaPlayer2.chrome.*) ◄──────────────────────────┘
```

- **`am.py`** (`src/backend/am.py`) is the CLI. Every command prints one JSON
  object on stdout and exits 0, or `{"error", "message"}` and exits 1. It
  starts the engine headless on demand, and drives it over CDP.
- **`cdp.py`** is a small stdlib WebSocket client for the DevTools protocol —
  no pip installs, PyGObject and the stdlib only.
- **`bridge.js`** is the *only* file whose code runs inside the Chrome page.
  It's injected idempotently and defines `window.__musicMenu = {status, play,
  playNext, playLater, control, seek, …}`. `am.py`'s commands are thin CDP
  calls into it — don't paste JS strings into `am.py` itself.
- **`sync.py`** turns MusicKit's API responses into `library.json`'s
  `Item`/`Track` shapes and manages the artwork cache. Pure functions, unit
  tested (`tests/test_sync.py`).

**The hard rule: no network or CDP from the shell process.** JS never talks
to Chrome directly. `src/lib/amctl.js` is the *only* door — it spawns
`am.py` asynchronously (`Gio.Subprocess`, async `communicate_utf8_async`)
and parses the JSON it prints; nothing else in `src/lib/` may shell out or
open a socket. Read `amctl.js` — it's short (`run()` resolves with the
parsed JSON or rejects with an `AmError {code, message}`; `fire()` is
fire-and-forget for UI actions that only need a log line on failure).

## Player follows Chrome, not a generic MPRIS scan

Video Menu's `playback.js` watches *any* MPRIS player for a file under a
watched folder. Music Menu's **`player.js`** is narrower and simpler: it
follows the engine's own MPRIS player specifically, matched by the engine's
PID (read from `$XDG_RUNTIME_DIR/music-menu/engine.json`, written by
`am.py`), not by scanning every player on the bus. MPRIS announces play/pause/
track-change but not a continuous position, so `Player` reckons position
locally off the monotonic clock between corrections (pause, seek, track
change, and a periodic `amctl.run(['now-playing'])` fallback when Chrome's
MPRIS doesn't expose Shuffle/LoopStatus). It emits `changed` and roughly
one `position` tick a second while playing; `state` is documented at the
top of `player.js`.

## `library.json`

The UI never scrapes and never talks to Chrome for a listing. `am.py sync`
(run from Preferences → Apple Music → Sync, or on `sync-interval`) is the
only writer of `~/.cache/music-menu/library.json` and its `art/` cache;
`src/lib/library.js` only reads it. The full `Item`/`Track` shape and the
`sections`/`shelves` layout are in `src/backend/README.md` — don't restate
them here or let them drift out of sync with that file.

## Settings

Schema `org.gnome.shell.extensions.music-menu`. Kept from Video Menu:
`library-opens-in`, `detail-opens-in`, `library-shortcut`, `columns`, `rows`,
`grid-align`, `corner-radius`, `detail-size`, `play-on-new-workspace`,
`gamepad-enabled` and every `keys-*`/`pad-*` (the `watched` action is now
`play-pause`). New: `albums-enabled`/`artists-enabled`/`playlists-enabled`/
`radio-enabled`/`listen-now-enabled` (which tabs show), `browser-command`,
`engine-port`, `engine-headless`, `engine-autostart`, `sync-interval`,
`player-bar`, `last-sync`. Removed entirely: `tv-shows-*`, `films-*`,
`credentials`, `tracking`, `watched-threshold`, `resume-*`, `player-command`
— none of that applies here, there's no folder scanner and no "watched"
concept.

## Tests and the check gate

```bash
python3 -m unittest discover -s tests -v   # backend unit tests (cdp.py, sync.py, demo schema)
./scripts/check.sh                          # JS syntax + schema compile + py_compile + unit tests
```

`./scripts/check.sh` is the one gate to run before calling anything done.

**Env overrides, so a test or a dev run never touches the user's real Chrome
profile or the real cache:**

| Variable | What it changes |
|---|---|
| `MUSIC_MENU_PROFILE` | Chrome's profile directory (default `$XDG_DATA_HOME/music-menu/chrome`) |
| `MUSIC_MENU_PORT` | the CDP debugging port (default from the `engine-port` setting, 9227) |
| `MUSIC_MENU_CACHE` | the cache directory (default `~/.cache/music-menu`) |

`scripts/nested.sh --demo` sets `MUSIC_MENU_CACHE` to a throwaway directory
and uses `scripts/demo_library.py` (a made-up library, drawn art, no Apple
account) instead of a real sync — that's what screenshots should come from,
never a real library.

## Coexisting with Video Menu and Games Menu

All three extensions can be enabled at once, and none of how Music Menu
reaches into shell internals may assume it's the only one doing so. Every
`GObject.registerClass`'d class here is `MusicMenu*`-prefixed
(`MusicMenuMediaView`, `MusicMenuPanel`, …), never the bare shell name or
another extension's prefix, and every stylesheet class is `mm-`-prefixed —
see Video Menu's `CLAUDE.md` ("Coexisting with Games Menu") for the
chain-safe-wrap pattern (Dash to Panel's `_updateGroupedElements`, the
overview layout's `_getAppDisplayBoxForState`) that lets two or three
extensions each wrap the same private shell methods without one's
disable/enable breaking another's.
