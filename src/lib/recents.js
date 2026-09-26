// What was picked out of a search, newest first: "Recently Searched" on
// Apple Music's own search page, and on ours (landingView.js). Kept beside
// library.json as a small JSON list of the items as the search handed them
// — no track lists — with the newest pick moved to the front and only so
// many kept. The shell is the only thing that knows what was picked, so it
// is the writer here; read back once at enable, so the list outlives a
// session. `changed` is emitted on every pick and on Clear.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {cacheDir} from './library.js';

const KEEP = 10;
// What a pick is remembered by: enough to draw its card and open it again.
const FIELDS = ['id', 'kind', 'title', 'subtitle', 'art', 'thumb', 'artColor', 'url',
    'catalogId', 'play', 'explicit', 'countLabel', 'year', 'genre'];

export class Recents extends EventEmitter {
    constructor() {
        super();
        this._path = GLib.build_filenamev([cacheDir(), 'recent-searches.json']);
        this._items = this._load();
    }

    get items() {
        return this._items;
    }

    // `item` to the front, once.
    add(item) {
        if (!item?.id || !item.kind || !item.title)
            return;
        const kept = {};
        for (const field of FIELDS) {
            if (item[field] !== undefined)
                kept[field] = item[field];
        }
        this._items = [kept, ...this._items.filter(it => it.id !== item.id || it.kind !== item.kind)].slice(0, KEEP);
        this._save();
        this.emit('changed');
    }

    clear() {
        if (!this._items.length)
            return;
        this._items = [];
        this._save();
        this.emit('changed');
    }

    _load() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            const parsed = ok ? JSON.parse(new TextDecoder().decode(bytes)) : [];
            return Array.isArray(parsed) ? parsed.filter(it => it?.id && it.kind && it.title).slice(0, KEEP) : [];
        } catch {
            return [];
        }
    }

    _save() {
        GLib.mkdir_with_parents(cacheDir(), 0o700);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._items)));
        Gio.File.new_for_path(this._path).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`[Music Menu] Could not save recent searches: ${e.message}`);
                }
            });
    }
}
