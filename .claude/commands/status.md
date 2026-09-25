---
description: Report install mode, shell state, and library size
allowed-tools: Bash(make status), Bash(./scripts/dev.sh status)
---

Run `make status` and report the four lines it prints:

- **install** — `symlink` means dev mode (edits in `src/` are live); `copy` means a
  real install that won't pick up edits until `make install` is re-run.
- **state** — `ACTIVE` is healthy. `unknown to the running shell` means the UUID was
  never registered, which needs a logout, not a reload.
- **cache** — `~/.cache/music-menu`, holding `library.json` and `art/`.
- **library** — item counts across sections (albums, artists, playlists, radio), or `not synced yet` (run `/sync`).

If anything is off, say which command fixes it.
