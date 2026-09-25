---
description: Sync Apple Music library and download artwork
allowed-tools: Bash(make sync), Bash(./scripts/dev.sh sync:*), Bash(./scripts/dev.sh status)
---

Sync the Apple Music library.

1. Run `make sync` (or `./scripts/dev.sh sync`). It uses `src/backend/am.py sync`
   to communicate with the background engine running music.apple.com, fetches
   the user's library sections (albums, artists, playlists, radio) and shelves
   (heavy rotation, recently added, recently played, made for you), downloads
   512×512 artwork into `~/.cache/music-menu/art/`, and atomically writes
   `~/.cache/music-menu/library.json`.
2. Report the per-section counts and status from the sync output.
3. Nothing else is needed: the running extension watches `library.json` and
   rebuilds itself when the file lands.

If the engine is not signed in or not running, `am.py` will report `not-signed-in`
or `engine-down`. Run `make signin` (or `./scripts/dev.sh signin`) to sign in
in a visible browser window.
