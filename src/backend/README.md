# Music Menu Backend

This directory contains the Python and page-side backend components for the Music Menu GNOME Shell extension.

## Components

- `am.py`: Command-line interface and daemon management for Apple Music integration. All commands print one JSON object to stdout and exit.
- `cdp.py`: Pure standard-library Chrome DevTools Protocol (CDP) WebSocket client for communicating with Chrome.
- `bridge.js`: Page-side helper injected into `music.apple.com` defining `window.__musicMenu` (wraps MusicKit JS API).
- `sync.py`: Normalisation functions transforming Apple Music API JSON into `library.json` schemas, managing artwork caching, pruning, and label formatting.

## Architecture

```
Extension (src/lib) ──spawn──> am.py <command> ──CDP (cdp.py)──> Chrome: music.apple.com (bridge.js)
        ▲  reads ~/.cache/music-menu/library.json + art/
        └──────────────── MPRIS (org.mpris.MediaPlayer2.chrome.*) ◄──────┘
```
