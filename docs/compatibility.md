# Compatibility

`metadata.json` claims GNOME Shell 48, 49 and 50. This page says what has
actually been run, what depends on the shell version, and what is new
compared with Video Menu — the sibling extension this one's UI mechanics
were copied from.

## What has been tested

- **GNOME Shell 50.5** on CachyOS (Arch-based), Wayland, with an NVIDIA
  GeForce GTX 1080 on the proprietary driver. The rest of the stack: mutter
  50.5, GJS 1.88.1, GLib 2.88.3, GTK 4.22.5, libadwaita 1.9.4, Python 3.14.7,
  Google Chrome stable.
- **The same shell headless and nested** (`make nested`), which is what the
  visual checks and screenshots run in.
- **The engine**: Chrome starting headless with the DevTools port bound to
  `127.0.0.1`, MusicKit answering the catalogue API without sign-in, and
  Chrome's media session appearing as an `org.mpris.MediaPlayer2.chrome.*`
  player on the session bus — all verified on the machine above, on the
  Google Chrome build (not Chromium: Chromium has no Widevine, so
  `mk.bitrate` and playback itself would not work there).

**GNOME 48 and 49 are claimed and have not been booted.** Every UI mechanism
this extension shares with Video Menu — the app grid, the folder-dialog pop-
up, the surface, the overview and workspace-slide clones, the libadwaita
widgets in `prefs.js` — is the *same code*, unchanged, that Video Menu's own
`docs/compatibility.md`
(`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu/docs/compatibility.md`)
audits line by line against the GNOME 48.0 and 49.0 sources. Read that
document for the actual version-sensitive expressions
(`Adw.ShortcutLabel ?? Gtk.ShortcutLabel`, `Adw.ToggleGroup`,
`Clutter.ClickGesture ?? Clutter.ClickAction`, the six-argument
`_getAppDisplayBoxForState`, `WORKSPACE_SLIDE_TIME`, the `48.0`/`49.0`/`50.5`
shape of `group._background`) — they apply here verbatim, since none of that
code changed in the copy. This page only covers what's new.

Not tested at all: GNOME 51 or later, multi-monitor, any Mesa GPU, any
virtual machine, any X11 session.

## What's new and version-sensitive

### The engine has no GNOME-version dependency

Chrome, CDP and MPRIS are independent of the GNOME Shell version — the
engine (`src/backend/`) runs as an ordinary user process outside the
compositor, so nothing in `am.py`, `cdp.py`, `bridge.js` or `sync.py` needs
auditing against a shell release. What it does depend on:

- **Google Chrome, not Chromium.** Widevine (needed for playback and for
  `mk.bitrate` to report the real value) ships only with the proprietary
  Google build. `browser-command` defaults to `google-chrome-stable`.
- **Chrome ≥ 136** refuses a remote-debugging port on the *default* profile;
  the engine always runs against its own profile
  (`$XDG_DATA_HOME/music-menu/chrome`), which sidesteps that regardless of
  the installed Chrome version.
- **MPRIS support depends on Chrome exposing its media session**, which
  every reasonably current Chrome does for a page that's actually playing
  audio (verified on the version installed at test time; not tied to a
  GNOME release).

*Check first, on any GNOME version:* `python3 src/backend/am.py status`
after a fresh Chrome install should report `{"engine": {...}, "authorized":
false, ...}` without needing anything GNOME-version-specific.

### Settings and tabs are new content, not new mechanism

`albums-enabled`/`artists-enabled`/`playlists-enabled`/`radio-enabled`/
`listen-now-enabled`, `browser-command`, `engine-port`, `engine-headless`,
`engine-autostart`, `sync-interval`, `player-bar` and `last-sync` are plain
GSettings keys read the same way `tv-shows-*`/`films-*` were — no new
libadwaita widget was needed to add them (`Adw.SwitchRow`, already at the
libadwaita 1.7 floor Video Menu's `Adw.ToggleGroup` sets). Nothing here moves
the version floor.

### The player bar and Now Playing view

`playerBar.js` and `nowPlaying.js` are new St widgets, not adaptations of
anything Video Menu had (it has no now-playing concept — a video plays in an
external player, not inside the shell). They're built from the same
primitives Video Menu's `widgets.js`/`detailView.js` already use
(`St.BoxLayout`, `St.Icon`, `Clutter.BinLayout`) and the same accent-colour
and `em`-sizing rules, so they carry no version dependency of their own
beyond the 48 floor those rules already require (`St.BoxLayout({orientation})`
and `-st-accent-color`, both 48+ — see Video Menu's CLAUDE.md, "The 48 floor
is the theme's, not the architecture's").

## Checklist for a new GNOME version

Follow Video Menu's own checklist
(`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu/docs/compatibility.md`,
"Checklist for a new GNOME version") for everything UI-side — it's the same
code. On top of that, for Music Menu specifically:

1. Confirm `am.py status`, `am.py sync` and playback control still work —
   these depend on Chrome and MPRIS, not on the shell, but are worth a smoke
   test alongside a shell upgrade since both often land around the same time.
2. Go through Listen Now, Albums, Artists, Playlists and Radio in each of the
   four `library-opens-in` places, and open the player bar into Now Playing.
3. If Video Menu and/or Games Menu are also installed and enabled, repeat
   with all enabled together (see CLAUDE.md, "Coexisting with Video Menu and
   Games Menu").
4. Only then add the version to `shell-version` in `metadata.json`.
