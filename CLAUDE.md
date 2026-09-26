# Music Menu

A GNOME Shell extension (`music-menu@jackt`) that puts the user's Apple Music
library in a menu beside Show Apps. It started as a copy of the sibling
**Video Menu** (`../GNOME-Video-Menu`) with the namespace renamed and the
back end swapped out, so most of the UI under `src/lib/` — the app grid, the
folder-style dialog, the overview clones, focus and keyboard handling — is
Video Menu's, and its `CLAUDE.md` is the fuller reference for that code and
for the general St/GNOME design rules. This file covers what's different.

## How it works

There's no paid API and no third-party client. The "engine" is Chrome running
music.apple.com in its own profile with DevTools (CDP) enabled, and the
extension drives Apple's own MusicKit player through it.

```
shell (src/lib) ──spawn──► src/backend/am.py <cmd> ──CDP──► Chrome: music.apple.com
   ▲  reads ~/.cache/music-menu/library.json + art/                │
   └────────────── MPRIS (org.mpris.MediaPlayer2.chrome.*) ◄───────┘
```

- `src/backend/am.py` — the CLI. One JSON object on stdout per command, or
  `{"error", "message"}` with exit 1. Starts the engine headless on demand.
  `src/backend/README.md` has the command table and the `library.json` shape.
- `cdp.py` — a tiny stdlib WebSocket client for DevTools. No pip installs.
- `bridge.js` — the only code that runs inside the Chrome page. It defines
  `window.__musicMenu` and `am.py` just calls into it.
- `sync.py` — turns MusicKit responses into `library.json` and manages the
  artwork cache. Pure functions, unit tested.

On the shell side, `src/lib/amctl.js` is the one place that talks to the
back end: it spawns `am.py` asynchronously and hands back the parsed JSON.
Nothing else in `src/lib/` shells out or opens a socket — keep it that way,
the shell process must never block on network or Chrome.

`player.js` follows the engine's own MPRIS player (matched by PID from
`engine.json` in `$XDG_RUNTIME_DIR/music-menu/`) for play/pause and the
track, but not for time: Chrome's MPRIS position and length are its media
element's, which Apple's gapless player runs across several tracks. The
track's own come from `am.py now-playing` (MusicKit), asked at each track
change, play, pause and `Seeked`, and every half minute while playing; the
position is reckoned off the monotonic clock in between. The volume is
MusicKit's own, not the system's: it rides with each `now-playing` answer,
is set through `am.py volume` (the sets coalesced, the latest waiting behind
the one out), and Apple's page keeps it across restarts; another player's is
its MPRIS `Volume`. Mute is volume nought, the level remembered to come back to.
`library.js` only reads `library.json`; `am.py sync` is the only writer.
`shelfView.js` builds Listen Now shelves as one-row instances of the same
grid view the tabs use, so they page and focus like everything else.
`searchProvider.js` is Apple Music in the shell's own overview search:
among every provider on the system it is one section, "Apple Music".
While the menu is up in the overview a search is Apple Music's alone —
typing runs the shell's search exactly as it runs over the app grid, the
menu fading out under the results, but `mediaMenu.js` wraps the results
view's `_doProviderSearch` so only Apple Music's providers are asked — and
it is laid out as Apple Music's own search box lays its answers out, one
provider per section: Top Results as a row of five icons, Apple's
completions of the typed term (`am.py suggest`, picked they are the next
search), then Artists, Albums, Songs, Playlists, Music Videos, Stations.
One `am.py search` serves them all. Before anything is typed, the keyboard
in the empty entry puts Apple Music's search page in the menu's place
(`landingView.js`): "Recently Searched" (`recents.js`, what was picked out
of searches) and "Browse Categories" (`am.py landing`); a category opens
as a room (`libraryView.js` `openRoom`), its shelves from `am.py category`.

## Settings

Schema `org.gnome.shell.extensions.music-menu`. Mostly Video Menu's
(layout, shortcuts, `keys-*`/`pad-*`, gamepad) plus per-tab `*-enabled`
toggles, engine options (`browser-command`, `engine-port`,
`engine-headless`, `engine-autostart`), `sync-interval`, `player-bar` and
`last-sync`. The schema XML is the source of truth.

## Working on it

```bash
./scripts/check.sh                          # JS syntax, schema, py_compile, unit tests
python3 -m unittest discover -s tests -v    # backend tests on their own
make nested / make preview                  # throwaway nested shell for visual checks
```

Run `check.sh` before calling something done. Use the nested shell (or the
`drive-extension` skill) for anything that has to be seen.

Env overrides keep tests and dev runs off the real profile and cache:
`MUSIC_MENU_PROFILE`, `MUSIC_MENU_PORT`, `MUSIC_MENU_CACHE`.
`scripts/nested.sh --demo` uses `scripts/demo_library.py`, a made-up library
with drawn art — screenshots come from that, never from a real account.

## Things worth knowing

- **GNOME 50 focus:** `St.FocusManager` handles arrow keys in the capture
  phase from the outermost focus group, so key handlers inside our views never
  see them while a tile is focused. Row-to-row movement is St's spatial search.
- **Coexisting with Video Menu and Games Menu:** all three can be enabled at
  once. Registered classes are `MusicMenu*`-prefixed, stylesheet classes
  `mm-`-prefixed, and anything that wraps a private shell method uses the
  chain-safe pattern from Video Menu's `CLAUDE.md` so one extension's
  enable/disable doesn't break another's.
- `docs/` has notes on compatibility, the private shell API we touch, and
  publishing.
