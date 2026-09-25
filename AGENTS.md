# Music Menu: build spec for every agent

Music Menu (UUID `music-menu@jackt`) is a GNOME Shell extension. It shows the
user's **Apple Music** library as a menu beside Show Apps: Listen Now shelves,
Albums, Artists, Playlists and Radio as tabs of square tiles. Picking an album
pops up an album pane with its track list. A **player bar** shows what's
playing. Where the library opens is a setting: the overview slot, a pop-up
panel, or the desktop wallpaper. Shell versions 48–50, tested on 50.5.

The app is a **copy of GNOME-Video-Menu** (`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu`, the sibling
extension for TV and films) with its namespace renamed: `media-libraries` →
`music-menu`, `MediaLibraries*` → `MusicMenu*`, `ml-` → `mm-`. Its `CLAUDE.md`
(`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu/CLAUDE.md`) explains every mechanism still in this tree,
including the grid, the folder-dialog pop-up, the surface, focus handling and
the gotchas. **Read it before changing anything under `src/lib/`.** Its
**Design rules and Gotchas sections apply here unchanged**, including:
- St is not the web, so no flexbox and no CSS variables.
- Font sizes are in `em`.
- Colour comes from `-st-accent-color`.
- Nothing blocks the compositor.
- Nothing builds an actor per item.
- Every GType is `MusicMenu*`-prefixed and every CSS class is `mm-`-prefixed.

`design/index.html` and `design/index2.html` are a rough teardown of the
music.apple.com web player. **Use them only as a layout guide**, never as code:
- square album lockups, round artist lockups
- the album page (art left; title, artist, genre and year, Play/Shuffle; track list right)
- song rows (number, title, explicit badge, duration, `•••`)
- a translucent player bar (art, title/artist, ⏮ ⏯ ⏭, scrubber, time)

Map every element onto St and the shell's own classes, never GTK. Keep the
resemblance loose, and let the GNOME look win.

## How playback and data work (verified 2026-09-25)

There is no paid token and no Cider. The **engine** is Google Chrome
(`google-chrome-stable`, which ships with Widevine) running music.apple.com in
its own profile, with the DevTools protocol (CDP) enabled. The user signs in
once in a visible window. After that it can run headless. The page exposes
Apple's own `MusicKit` (v3.x) as a global, so:

```js
const mk = MusicKit.getInstance();          // works on music.apple.com, verified
await mk.api.music('/v1/catalog/us/search', {term, types: 'albums'}) // → {data: {results…}}
await mk.api.music('/v1/me/library/albums', {limit: 100, offset})    // needs sign-in
await mk.setQueue({album: id, startWith: 0, startPlaying: true}); // also {playlist}, {station}, {song}, {songs: [...]}
mk.playNext({song: id}); mk.playLater({album: id});
mk.shuffleMode = MusicKit.PlayerShuffleMode.songs; mk.repeatMode = MusicKit.PlayerRepeatMode.all;
mk.isAuthorized; mk.storefrontId; mk.bitrate  // 256 by default
mk.addEventListener('nowPlayingItemDidChange' | 'playbackStateDidChange' | 'queueItemsDidChange', fn)
```

Headless Chrome reports Widevine as available, and the catalog API answers
without sign-in (both verified). The lyrics endpoint
`/v1/catalog/{sf}/songs/{id}/lyrics` answers with JSON (a 404 when a song has
none), so it is reachable. Chrome also exposes the page's media session as an
**MPRIS** player on the session bus. That gives now-playing, position and
transport to the shell for free.

```
Extension (src/lib, in the shell) ──spawn──► src/backend/am.py <command> ──CDP──► Chrome: music.apple.com
        ▲  reads ~/.cache/music-menu/library.json + art/     (one-shot, JSON on stdout)      │
        └──────────────── MPRIS (org.mpris.MediaPlayer2.chrome.*) ◄──────────────────────────┘
```

**Hard rules**
- **No network or CDP from the shell process.** The JS spawns `am.py`
  asynchronously through `lib/amctl.js`, and nothing else. It reads files that
  Python wrote, and it follows playback over MPRIS (Gio D-Bus, async).
- **Python uses the stdlib plus PyGObject only.** No pip installs. `cdp.py`
  is a small stdlib WebSocket client.
- **The engine's page-side code lives in one file**, `src/backend/bridge.js`.
  It is injected (idempotently) into the page and defines
  `window.__musicMenu = {status, play, playNext, playLater, control, seek, …}`.
  `am.py` commands are thin calls into it. Don't paste JS strings all over
  Python.
- The engine profile is `$XDG_DATA_HOME/music-menu/chrome` (`~/.local/share/...`).
  Chrome ≥136 refuses a debugging port on the default profile, and a profile of
  its own keeps the port away from the user's browsing. The port is bound to
  127.0.0.1.
- **Tests and dev runs must never touch the real profile or port.** Use
  `MUSIC_MENU_PROFILE=<tmpdir>` and `MUSIC_MENU_PORT=<free port>`. `am.py`
  honours both, plus `MUSIC_MENU_CACHE` for the cache directory.

## `am.py` command contract (src/backend/am.py)

Every command prints **one JSON object on stdout** and exits 0. On failure it
prints `{"error": "<code>", "message": "..."}` and exits 1. Error codes:
- `engine-down`: Chrome isn't running and autostart was off or failed
- `not-signed-in`
- `api`
- `timeout`
- `usage`

Commands that need the engine start it headless first unless `--no-start` is
given. The engine's state file is `$XDG_RUNTIME_DIR/music-menu/engine.json`:
`{pid, port, headless, profile, started}`.

| Command | Result |
|---|---|
| `engine start [--visible\|--headless]`, `engine stop`, `engine status` | `{running, pid, port, headless}` |
| `signin` | Restarts the engine **visible** at music.apple.com and calls `mk.authorize()`. Returns `{authorized}` |
| `status` | `{engine, authorized, storefront, bitrate}` |
| `sync [--only albums\|artists\|playlists\|radio\|shelves]` | Writes library.json atomically (merged per section, under `flock`) and artwork. Returns `{counts: {...}, generated}` |
| `item <kind> <id>` | A full item with `groups`, for a search result or shelf item picked on demand |
| `play <kind> <id> [--start-with N] [--shuffle]` | `{ok: true}`. kind ∈ `album playlist station song artist` |
| `play-next <kind> <id>`, `play-later <kind> <id>` | `{ok: true}` |
| `control play\|pause\|toggle\|next\|previous\|stop`, `seek <sec>`, `volume <0..1>` | `{ok: true}` |
| `shuffle on\|off\|toggle`, `repeat none\|one\|all\|cycle` | `{shuffle, repeat}` |
| `now-playing` | `{state, track, position, duration, shuffle, repeat, volume}`, with `track` in the track shape below |
| `queue` | `{index, items: [track…]}` |
| `love <kind> <id>`, `unlove <kind> <id>` | `{ok: true}` (PUT/DELETE `/v1/me/ratings/{kind}s/{id}`) |
| `add-to-library <kind> <id>` | `{ok: true}` |
| `playlists` | `{items: [{id, title}]}` (library playlists the user can edit) |
| `add-to-playlist <playlistId> <songId>` | `{ok: true}` |
| `lyrics <catalogSongId>` | `{synced, lines: [{startMs, endMs, text}]}`, also cached at `<cache>/lyrics/<id>.json` |
| `search <term> [--library] [--limit N]` | `{items: [item without groups]}` (albums, artists, playlists, songs) |

## `library.json` (the only thing the UI reads for the library)

`~/.cache/music-menu/library.json`, written only by `am.py sync` (or by
`scripts/demo_library.py` for demos and tests):

```jsonc
{
  "version": 1, "generated": "2026-09-25T12:00:00Z", "storefront": "us",
  "sections": {
    "albums":    [Item], "artists": [Item], "playlists": [Item], "radio": [Item]
  },
  "shelves": [ {"key": "heavy-rotation", "title": "Heavy Rotation", "items": [Item]},
               {"key": "recently-added", "title": "Recently Added", "items": [Item]},
               {"key": "recently-played", "title": "Recently Played", "items": [Item]},
               {"key": "made-for-you", "title": "Made for You", "items": [Item]} ]
}
```

```jsonc
Item = {
  "id": "l.abc123",            // unique within its section; library id, or catalog id if not in library
  "kind": "album" | "playlist" | "artist" | "station",
  "title": "Rise or Die Trying", "subtitle": "Four Year Strong",   // artist, curator, "Apple Music"
  "year": 2007, "genre": "Rock", "summary": "editorial notes, plain text" /* or null */,
  "art": "/home/u/.cache/music-menu/art/<sha1>.jpg" /* or null */, "artColor": "#1a1a1a" /* or null */,
  "countLabel": "12 songs, 43 min", "explicit": false,
  "catalogId": "1724040700" /* or null */, "url": "https://music.apple.com/..." /* or null */,
  "play": {"kind": "album", "id": "l.abc123"},          // what `am.py play` gets
  "groups": [ {"name": "Disc 1", "play": {"kind": "album", "id": "l.abc123"},
               "entries": [Track] } ]                   // artists: one group per album; stations: []
}
Track = { "id": "i.xyz", "catalogId": "1724040711" /* or null */, "title": "...", "artist": "...",
          "album": "...", "trackNumber": 1, "discNumber": 1, "durationMs": 216000,
          "durationLabel": "3:36", "explicit": true, "index": 0 }   // index = position in group.play's queue
```

Artwork is fetched at 512×512 (Apple's URL template `{w}x{h}` → `512x512`) into
`<cache>/art/`. Paths outside the cache count as missing. A track row plays
`group.play` with `--start-with entry.index`.

## Settings (schema `org.gnome.shell.extensions.music-menu`)

**Keep from Video Menu:**
- `library-opens-in`, `detail-opens-in`, `library-shortcut`, `columns`, `rows`, `grid-align`, `corner-radius`, `detail-size`, `play-on-new-workspace` (default false)
- `gamepad-enabled`, every `keys-*` and `pad-*`. The `watched` action becomes `play-pause`: `keys-play-pause` / `pad-play-pause`.

**Remove:** every `tv-shows-*` and `films-*` key, `credentials`, `tracking`, `watched-threshold`, `resume-*` and `player-command`.

**Add:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `albums-enabled`, `artists-enabled`, `playlists-enabled`, `radio-enabled`, `listen-now-enabled` | b | true | Which tabs show |
| `browser-command` | s | `'google-chrome-stable'` | The engine browser |
| `engine-port` | i | 9227 | |
| `engine-headless` | b | true | |
| `engine-autostart` | b | true | Start the engine when the library opens |
| `sync-interval` | i | 60 | Minutes between automatic syncs; 0 = off |
| `player-bar` | b | true | Show the player bar |
| `last-sync` | s | `''` | Written by the extension after a sync |

## Layout of the tree

```
src/extension.js             stages lib/ and imports app.js (unchanged mechanism)
src/lib/app.js               owns everything; wires library, player, surface
src/lib/library.js           SECTIONS (listen-now, albums, artists, playlists, radio), loadLibrary()
src/lib/amctl.js             THE ONLY way JS talks to am.py (async spawn + JSON). Contract, see file.
src/lib/player.js            Player: follows the engine's MPRIS player, emits 'changed'; transport via MPRIS
src/lib/playerBar.js         the player bar widget (art, title/artist, ⏮ ⏯ ⏭, scrubber, time)
src/lib/nowPlaying.js        full now-playing view: big art, lyrics, Up Next queue
src/lib/shelfView.js         Listen Now: vertical list of horizontal shelves of tiles
src/lib/itemMenu.js          right-click / ••• menu (PopupMenu): Play Next/Later, Love, Add to Library/Playlist, Copy Link
src/lib/searchProvider.js    overview search provider backed by `am.py search`
src/lib/{libraryView,mediaGrid,detailView,detailDialog,widgets,shape,panel,…}.js   from Video Menu, adapted
src/backend/am.py            CLI above;  cdp.py  stdlib CDP client;  bridge.js  page-side helper;
src/backend/sync.py          API → Item/Track normalisation + artwork cache (pure functions, unit-tested)
src/prefs.js                 General · Apple Music (engine, sign-in, sync) · Controls
scripts/demo_library.py      writes a made-up library.json + drawn square art (no Apple account needed)
tests/                       python -m unittest discover -s tests   (backend unit tests + fixtures)
```

`tracking.js` (watched marks) and the Video Menu scanner (`scan_library.py`,
`media_scanner.py`, `metadata.py`) are removed.

## Commands

```bash
python3 -m unittest discover -s tests -v             # backend tests, must pass
python3 -m py_compile src/backend/*.py               # syntax
./scripts/check.sh                                     # JS syntax + schema + py_compile + unit tests: the gate every job passes
glib-compile-schemas --strict --dry-run src/schemas   # schema must compile
make link && make reload && make logs                 # real shell (lead only)
./scripts/nested.sh start --clean --demo              # nested shell with the demo library (ONE agent at a time)
```


**Only the lead runs the nested shell or the real shell unless a brief says
otherwise.** Two nested shells collide on the same Wayland display name.

## Conventions

- Match Video Menu's code style: comments explain *why* in full sentences, and
  code is named plainly. Log tag `[Music Menu]`.
- Commit on your branch with clear messages. End each commit message with
  `Co-Authored-By: Gemini (agy) <noreply@google.com>`.
- Don't edit files your brief doesn't give you. If you need a change there,
  say so in your final report.

## Module contracts between parallel jobs

These are fixed so that jobs building each side in parallel meet in the
middle. Implement exactly these names and signatures. If you only consume one,
import it and don't create a stub of it: the other job's branch brings the
real file.

```js
// player.js  (owner: player job)
export class Player {            // extends Signals.EventEmitter (misc/signals.js)
    constructor();               // starts following the engine's MPRIS player (Chrome's media session)
    get state();                 // {status: 'Playing'|'Paused'|'Stopped', track: {title, artist, album, artUrl, lengthUs} | null,
                                 //  positionUs, canNext, canPrevious, canSeek, shuffle, repeat}
    playPause(); next(); previous(); seek(positionUs);   // MPRIS
    // emits 'changed' (any state change) and 'position' (about 1/s while playing, reckoned locally, not polled)
    destroy();
}
// playerBar.js (owner: player job)
export class PlayerBar {         // .actor is an St widget, full width, about 64px tall
    constructor({player, onOpenNowPlaying});
    get actor(); destroy();
}
// nowPlaying.js (owner: player job)
export class NowPlayingView {    // big art + title + scrubber + transport, a Lyrics tab and an Up Next tab
    constructor({player});       // lyrics/queue come from amctl.run(['lyrics', id]) / (['queue'])
    get actor(); destroy();
}
// shelfView.js (owner: extras job)
export class ShelfView {         // vertical ScrollView of shelves; each shelf is a title + "See All ›" + a horizontal row of tiles
    constructor({shelves, tileSize, onActivate(item, sourceActor), onContextMenu(item, sourceActor)});
    get actor(); destroy();
}
// itemMenu.js (owner: extras job)
export function openItemMenu({item, track = null, sourceActor});   // PopupMenu at sourceActor, all actions via amctl
// searchProvider.js (owner: extras job)
export class MusicSearchProvider { constructor({onActivate(item)}); register(); unregister(); }
// libraryView.js (owner: ui-library job)
LibraryView.prototype.setFooter(actor | null);   // the player bar slot under the tabs + grid
```

`app.js` (owner: ui-library job) creates one `Player` for the whole extension,
builds a `PlayerBar` into every `LibraryView` footer (when `player-bar` is on),
registers `MusicSearchProvider`, and opens `openItemMenu` from a tile's
right-click and a row's `•••`.
