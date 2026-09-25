// The player bar: a compact, centred card under a library's tabs
// (libraryView's footer slot; the CSS width caps it to the grid's own block
// rather than the full screen). Art, title and artist on the left, clickable
// through to Now Playing, and the shared transport and scrubber
// (playerWidgets.js) in the middle. With no track it shrinks
// (`mm-player-bar-compact`) to a "Not Playing" line — or a Start button when
// the engine itself is down, which is polled for while nothing plays.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as amctl from './amctl.js';
import {createLabel} from './widgets.js';
import {Transport, createRemoteArt} from './playerWidgets.js';

// How often to ask `engine status` while nothing is playing, to notice the
// engine coming up (or going down) without the user touching anything.
const ENGINE_POLL_MS = 8000;

export class PlayerBar {
    constructor({player, onOpenNowPlaying}) {
        this._player = player;
        this._engineRunning = null;   // null: not asked yet
        this._engineTimer = 0;

        // Not `x_expand`/FILL: a plain BoxLayout child of libraryView's
        // vertical box defaults to filling the full width, which is what
        // made this a full-width strip. CENTER instead sizes it to its own
        // CSS `width` (a compact card) and centres that under the grid.
        this.actor = new St.BoxLayout({
            style_class: 'mm-player-bar',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._left = new St.Button({
            style_class: 'mm-player-bar-left',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Now Playing',
        });
        this._left.connect('clicked', () => onOpenNowPlaying?.());
        const left = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._art = createRemoteArt({styleClass: 'mm-player-bar-art', size: 40});
        left.add_child(this._art);
        const meta = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-player-bar-meta',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = createLabel('', 'mm-player-bar-title');
        this._artist = createLabel('', 'mm-player-bar-artist');
        meta.add_child(this._title);
        meta.add_child(this._artist);
        left.add_child(meta);
        this._left.set_child(left);
        this.actor.add_child(this._left);

        this._empty = createLabel('Not Playing', 'mm-player-bar-empty', {
            x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._empty);

        this._start = new St.Button({
            style_class: 'button default mm-player-bar-start',
            label: 'Start Apple Music',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._start.connect('clicked', () => this._startEngine());
        this.actor.add_child(this._start);

        this._transport = new Transport({player, prefix: 'mm-player-bar'});
        this._transport.actor.add_style_class_name('mm-player-bar-center');
        this.actor.add_child(this._transport.actor);

        player.connectObject('changed', () => this._render(), this);
        this._render();
    }

    _render() {
        const track = this._player.state.track;
        this._left.visible = !!track;
        this._transport.actor.visible = !!track;
        if (track) {
            this.actor.remove_style_class_name('mm-player-bar-compact');
            this._stopEnginePoll();
            this._empty.hide();
            this._start.hide();
            this._title.text = track.title;
            this._artist.text = track.artist;
            this._art.setUrl(track.artUrl);
        } else {
            this.actor.add_style_class_name('mm-player-bar-compact');
            this._showEngineState();
            this._startEnginePoll();
        }
    }

    _showEngineState() {
        this._empty.visible = this._engineRunning !== false;
        this._start.visible = this._engineRunning === false;
    }

    async _checkEngine() {
        try {
            const res = await amctl.run(['engine', 'status']);
            this._engineRunning = !!res.running;
        } catch {
            this._engineRunning = false;
        }
        if (!this._destroyed && !this._player.state.track)
            this._showEngineState();
    }

    async _startEngine() {
        this._start.reactive = false;
        this._start.label = 'Starting…';
        try {
            await amctl.run(['engine', 'start']);
        } catch {
            // Logged by amctl; the status check below shows the outcome.
        }
        if (this._destroyed)
            return;
        this._start.reactive = true;
        this._start.label = 'Start Apple Music';
        this._checkEngine();
    }

    _startEnginePoll() {
        if (this._engineTimer)
            return;
        this._checkEngine();
        this._engineTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ENGINE_POLL_MS, () => {
            this._checkEngine();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopEnginePoll() {
        if (this._engineTimer)
            GLib.source_remove(this._engineTimer);
        this._engineTimer = 0;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopEnginePoll();
        this._player.disconnectObject(this);
        this._transport.destroy();
        this.actor.destroy();
    }
}
