# Publishing to extensions.gnome.org

How to build the upload, what goes in it, and how Music Menu stands against
the EGO review guidelines. The guidelines are gjs.guide's
[Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

Private API use is covered in [private-api.md](private-api.md) rather than
repeated here.

## Personal use first

Read this before spending time on the rest of this page: **a review is
likely to stop hard on the engine.** Video Menu's own bundled Python backend
(a folder scanner making read-only lookups to TVmaze/TMDB/Wikipedia) already
drew a "the review's centre of gravity" note in that extension's own
`publishing.md` — Music Menu's backend is a materially bigger ask. `am.py`
doesn't just fetch metadata; it **launches and drives a full copy of Google
Chrome** over the DevTools protocol, injects JavaScript into a live
music.apple.com page, and calls the page's own `MusicKit` object to sign in,
search, queue and play. That is exactly the shape of thing
extensions.gnome.org review exists to be cautious about: an extension
automating a whole second browser process is a much larger, much less
auditable surface than a scanner making a few read-only HTTPS calls, and
"why can't this be GJS" has no good answer here — there is no GJS Widevine,
no GJS MusicKit, and the entire point is to reuse Apple's own web player
rather than reimplement DRM playback.

None of this makes Music Menu unsafe to run — it only automates a browser
the user already trusts with their Apple ID, using a profile of its own, and
every network call visible to `am.py` is one MusicKit itself would make
anyway — but it is genuinely unusual for an EGO listing, and a reviewer who
has never seen anything like it may simply decline it regardless of how well
it's explained. **Treat this as a personal-use extension first.** `make
install` and `make link` work exactly the same whether or not it's ever
uploaded; there is no reason to gate development on a review decision. If
publishing is attempted later, budget time to explain the engine plainly in
`description` and in the upload notes — pointing at this page and
`private-api.md` — and go in expecting follow-up questions, not a quick
approval.

## Building the zip

```sh
make pack
```

This runs `scripts/dev.sh pack`, the same way Video Menu's does: compiles
the GSettings schema, copies `src/` into a temporary directory, strips
`__pycache__/`, `*.pyc` and every `CLAUDE.md`, then runs `gnome-extensions
pack --extra-source=lib --extra-source=backend --extra-source=icons`. Read
the actual `unzip -l dist/music-menu@jackt.shell-extension.zip` output before
every upload — there is no automated check that the zip's contents match an
expected list.

What ships, and why each part is there:

- **`extension.js`, `metadata.json`, `prefs.js`, `stylesheet.css`,
  `schemas/*.gschema.xml`** — the entry points `gnome-extensions` always
  looks for.
- **`lib/`** — the shell-side implementation: the surface, the grid, the
  album pane, the player bar and Now Playing, the search provider, controls,
  and the wrap/unwrap points into Dash to Panel and the overview. All of it
  runs inside the compositor process and never touches the network directly
  — see the hard rule in `CLAUDE.md`.
- **`backend/`** — `am.py`, `cdp.py`, `bridge.js`, `sync.py`: the Python/CDP
  program that runs Chrome, drives MusicKit, and writes
  `~/.cache/music-menu/library.json` and its artwork cache. Not GJS, and the
  part of this extension a review will focus on — see "Personal use first"
  above and [Scripts, subprocesses and network access](#scripts-subprocesses-and-network-access)
  below.
- **`icons/`** — the one symbolic icon for the button beside Show Apps.

Left out, and safe to leave out: `src/schemas/gschemas.compiled` (compiled
on install by `gnome-extensions`, not shipped), `__pycache__/`/`*.pyc`,
every `CLAUDE.md`, and everything outside `src/` (`scripts/`, `README.md`,
`docs/`, `.claude/`, `.git`, `dist/` are never seen by the packer at all).

### Testing the zip before uploading

```sh
make uninstall
make pack
gnome-extensions install dist/music-menu@jackt.shell-extension.zip
# log out and back in, then enable it
```

Not `gnome-extensions install --force` over the development symlink — that
deletes the existing extension directory *through* the symlink, emptying
`src/` itself. `make link` restores the development link afterwards.

## metadata.json

| Key | Now | Verdict |
|---|---|---|
| `uuid` | `music-menu@jackt` | Fine — cannot change after the first upload |
| `name` | `Music Menu` | Fine |
| `description` | one line | Needs to say much more before any upload — see below |
| `settings-schema` | set | Correct |
| `shell-version` | `["48", "49", "50"]` | All released, so allowed; 48 and 49 are audited against the shell's sources, not booted — see `compatibility.md` |
| `version` | `1` | **Should be removed before upload.** EGO assigns and increments this itself |
| `version-name` | absent | Worth adding, `"1.0"` or similar (letters, numbers, space, period only — no dash) |
| `url` | absent | Add, pointing at the repo, once one exists publicly |
| `session-modes` | absent | Correct — `user` only |

**`description`** is where a reviewer or a user first learns about behaviour
that would otherwise look alarming. At minimum it needs to say, plainly:

- it starts a separate, dedicated **Google Chrome** process and profile and
  drives Apple's own music.apple.com web player through it over Chrome's
  DevTools protocol — this is *how* it plays Apple Music, not a background
  side effect;
- an Apple Music **subscription is required**, and the first run opens a
  visible Chrome window to sign in with the user's own Apple ID, exactly as
  in any browser;
- after sign-in the engine can run **headless**, still as Chrome, still
  under the user's own Apple ID session;
- audio is the **web player's own quality** (256 kbps AAC), not a native
  app's;
- it reaches several private GNOME Shell internals to sit the library beside
  Show Apps, fold the overview's workspace row, and clone pages into the
  overview's previews and the workspace slide — enumerated in
  [private-api.md](private-api.md).

## The review guidelines, point by point

Everything about the **shell-side code's** compliance — static
initialization, destroying objects and disconnecting signals on `disable()`,
no deprecated modules, no GTK in the shell, no obfuscation, session modes,
the schema's structure — carries over unchanged from Video Menu's own
`publishing.md` audit
(`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu/docs/publishing.md`),
since `app.js`'s teardown, the panel/grid/surface code and `prefs.js`'s
widget set are the same code, renamed. Re-run that page's spot-checks against
this tree's `lib/app.js`, `lib/player.js`, `lib/controls.js` before an actual
upload rather than assuming they still hold — a new module (`player.js`,
`playerBar.js`, `nowPlaying.js`, `searchProvider.js`) is new surface that
audit never looked at.

### Scripts, subprocesses and network access: the actual review question

This is where Music Menu diverges hardest from its sibling, and it's the
one section worth reading in full before ever uploading (see "Personal use
first" above for the blunt version).

- **What's spawned.** `lib/amctl.js` runs `python3 <ext>/backend/am.py
  <command>` with `Gio.Subprocess`, async, stdout/stderr piped and parsed as
  JSON — never a shell string, never a credential on the command line.
  `am.py`, on demand, launches `google-chrome-stable` (or `browser-command`)
  with a dedicated profile directory and a debugging port bound to
  `127.0.0.1` only.
- **What network access actually happens.** Chrome loads music.apple.com
  like any browser tab; `am.py`/`cdp.py` never open a socket to Apple
  themselves — they open a **local** WebSocket to Chrome's own DevTools port
  and ask the *page* to call `MusicKit.getInstance().api.music(...)`, the
  same call the page's own UI makes. Nothing here is a second, independent
  network client impersonating Apple's app; it's automation of the one Apple
  already ships to the browser.
- **Why this can't reasonably be GJS.** There is no GJS Widevine and no GJS
  MusicKit; the entire design exists *because* Apple only offers this
  catalogue through DRM-gated web playback, which only a real browser can do.
  A same-language rewrite isn't an option the way it might be for a plain
  metadata fetch.
- **Credentials.** There is no API key anywhere in this extension. The
  user's Apple ID session lives inside Chrome's own profile
  (`$XDG_DATA_HOME/music-menu/chrome`), the same as it would for any site
  they log into in a browser — Music Menu never sees a password, a token, or
  anything else to leak, log, or put on a command line.
- **No telemetry, no clipboard access, no privileged subprocess** — `am.py`
  and `cdp.py` talk only to the local Chrome instance they started
  themselves; nothing calls `pkexec`, nothing touches `St.Clipboard`.

None of that is a defence that a review will necessarily accept — it's an
honest description of what to say when asked, not a guarantee the answer
will be "approved." Decide, before spending more time on this page, whether
publishing is even the goal right now (see "Personal use first").

### Extensions must be functional: worth a note

Until the user signs in and syncs, every tab is empty with a sign-in hint —
by design, not a bug, the same as Video Menu having no default folder.
Worth a line in `description` so that reads as intended.

### Licensing

No `LICENSE`/`COPYING` yet. Same requirement as Video Menu: GNOME Shell is
GPL-2.0-or-later, so a derived extension needs compatible terms. Add one at
the top of `src/` (not the repo root) before packing, since `cmd_pack` only
ever sees `src/`.

### Use a linter: recommended

No ESLint configuration. Cheap to add before a first upload; would likely
surface some of the optional-chaining and logging patterns worth checking by
hand otherwise.

## Before uploading

1. **Decide whether to upload at all** — see "Personal use first".
2. **Write an honest `description`** covering the Chrome/DevTools/MusicKit
   mechanism, the subscription requirement, the sign-in flow, and the audio
   quality — not just "shows your Apple Music library."
3. **Add a `LICENSE`** at the top of `src/`.
4. **Remove `version`** from `metadata.json`; add `url` and `version-name`.
5. **Re-run Video Menu's own shell-side audit** (object/signal teardown, no
   excessive logging, the dynamic-import staging question) against this
   tree's actual files — don't assume it still holds without checking.
6. **Run `glib-compile-schemas --strict --dry-run src/schemas`** and
   `./scripts/check.sh` before every upload.
7. **Test the packed zip, not the development link** — `make uninstall`,
   `make pack`, `gnome-extensions install`, log out and in.

## Uploading

- **Web:** https://extensions.gnome.org/upload/.
- **Command line** (gnome-extensions 49+): `gnome-extensions upload
  --accept-tos dist/<uuid>.shell-extension.zip` — never put the EGO password
  on a bare command line; use `--password-file` or the interactive prompt.

Each upload is reviewed before publication; EGO assigns and increments
`version` itself.
