// The player bar: a full-width strip under a library's tabs (libraryView's
// footer slot), always the same three widgets — art/title/artist on the
// left, transport and a scrubber in the middle — whatever the engine is
// doing. Nothing here talks to MPRIS directly: everything reads Player's
// `state` and its 'changed'/'position' signals, and every action either
// calls back into Player (which knows the MPRIS fallbacks) or fires an
// am.py command straight off, exactly as the shuffle/repeat buttons do.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import * as amctl from './amctl.js';
import {createIconButton, createLabel} from './widgets.js';
import {formatTime, cacheRemoteArt} from './playerUtil.js';

// How often to re-poll `engine status` while nothing is playing, to notice
// the engine coming up (or going down) without the user touching anything.
const ENGINE_POLL_MS = 8000;

function artStyle(path) {
    return `background-image: url("file://${encodeURI(path)}"); background-size: cover;`;
}

export class PlayerBar {
    constructor({player, onOpenNowPlaying}) {
        this._player = player;
        this._onOpenNowPlaying = onOpenNowPlaying;
        this._destroyed = false;

        this._cancellable = new Gio.Cancellable();
        this._artCancellable = null;
        this._artUrl = null;

        this._scrubbing = false;
        this._length = 0;

        this._engineRunning = null; // null = unknown yet
        this._engineCheckId = 0;

        this._buildActor();

        this._changedId = player.connect('changed', () => this._render());
        this._positionId = player.connect('position', posUs => this._onPosition(posUs));

        this._render();
    }

    get actor() {
        return this._actor;
    }

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------
    _buildActor() {
        this._actor = new St.BoxLayout({style_class: 'mm-player-bar', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

        // Left: art + title/artist, clickable through to Now Playing.
        this._left = new St.Button({
            style_class: 'mm-player-bar-left',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Now Playing',
        });
        this._left.connect('clicked', () => this._onOpenNowPlaying?.());
        const leftContent = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._art = new St.Widget({
            style_class: 'mm-player-bar-art',
            layout_manager: new Clutter.BinLayout(),
            width: 40,
            height: 40,
            y_align: Clutter.ActorAlign.CENTER,
        });
        leftContent.add_child(this._art);
        const meta = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-player-bar-meta',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = createLabel('', 'mm-player-bar-title');
        this._artist = createLabel('', 'mm-player-bar-artist');
        meta.add_child(this._title);
        meta.add_child(this._artist);
        leftContent.add_child(meta);
        this._left.set_child(leftContent);

        // Shown instead of the left zone when nothing is playing.
        this._empty = createLabel('Not Playing', 'mm-player-bar-empty', {
            x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });

        // Shown instead of the left zone when the engine itself is down.
        this._startButton = new St.Button({
            style_class: 'button default mm-player-bar-start',
            label: 'Start Apple Music',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._startButton.connect('clicked', () => this._startEngine());

        this._actor.add_child(this._left);
        this._actor.add_child(this._empty);
        this._actor.add_child(this._startButton);

        // Center: transport row above a scrubber row.
        this._center = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-player-bar-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const transport = new St.BoxLayout({style_class: 'mm-player-bar-transport', x_align: Clutter.ActorAlign.CENTER});
        this._shuffleBtn = createIconButton('media-playlist-shuffle-symbolic', {styleClass: 'icon-button mm-player-bar-btn', accessibleName: 'Shuffle'});
        this._prevBtn = createIconButton('media-skip-backward-symbolic', {styleClass: 'icon-button mm-player-bar-btn', accessibleName: 'Previous'});
        this._playBtn = createIconButton('media-playback-start-symbolic', {styleClass: 'icon-button mm-player-bar-play', accessibleName: 'Play'});
        this._nextBtn = createIconButton('media-skip-forward-symbolic', {styleClass: 'icon-button mm-player-bar-btn', accessibleName: 'Next'});
        this._repeatBtn = createIconButton('media-playlist-repeat-symbolic', {styleClass: 'icon-button mm-player-bar-btn', accessibleName: 'Repeat'});
        this._shuffleBtn.connect('clicked', () => this._toggleShuffle());
        this._prevBtn.connect('clicked', () => this._player.previous());
        this._playBtn.connect('clicked', () => this._player.playPause());
        this._nextBtn.connect('clicked', () => this._player.next());
        this._repeatBtn.connect('clicked', () => this._cycleRepeat());
        for (const button of [this._shuffleBtn, this._prevBtn, this._playBtn, this._nextBtn, this._repeatBtn])
            transport.add_child(button);
        this._center.add_child(transport);

        const scrubberRow = new St.BoxLayout({style_class: 'mm-player-bar-scrubber', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._elapsed = new St.Label({style_class: 'mm-player-bar-time', text: '0:00'});
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.connect('drag-begin', () => {
            this._scrubbing = true;
        });
        this._slider.connect('drag-end', () => {
            this._scrubbing = false;
            this._commitSeek();
        });
        this._slider.connect('notify::value', () => this._onSliderValue());
        this._remaining = new St.Label({style_class: 'mm-player-bar-time', text: '0:00'});
        scrubberRow.add_child(this._elapsed);
        scrubberRow.add_child(this._slider);
        scrubberRow.add_child(this._remaining);
        this._center.add_child(scrubberRow);

        this._actor.add_child(this._center);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    _render() {
        if (this._destroyed)
            return;

        const state = this._player.state;
        const track = state.track;
        this._length = track?.lengthUs || 0;

        this._left.visible = !!track;
        this._center.visible = !!track;
        if (!track) {
            this._empty.visible = this._engineRunning !== false;
            this._startButton.visible = this._engineRunning === false;
            this._scheduleEngineCheck();
            return;
        }

        this._stopEngineCheck();
        this._empty.hide();
        this._startButton.hide();

        this._title.text = track.title || '';
        this._artist.text = track.artist || '';
        this._updateArt(track.artUrl);

        const playing = state.status === 'Playing';
        this._playBtn.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playBtn.accessible_name = playing ? 'Pause' : 'Play';
        this._prevBtn.reactive = !!state.canPrevious;
        this._nextBtn.reactive = !!state.canNext;
        this._slider.reactive = !!state.canSeek && this._length > 0;

        this._shuffleBtn.checked = !!state.shuffle;
        this._repeatBtn.checked = state.repeat !== 'none';
        this._repeatBtn.icon_name = state.repeat === 'one'
            ? 'media-playlist-repeat-song-symbolic'
            : 'media-playlist-repeat-symbolic';

        if (!this._scrubbing)
            this._updatePosition(state.positionUs);
    }

    _onPosition(posUs) {
        if (this._destroyed || this._scrubbing)
            return;
        this._updatePosition(posUs);
    }

    _updatePosition(posUs) {
        this._slider.value = this._length > 0 ? Math.min(1, Math.max(0, posUs / this._length)) : 0;
        this._setTimeLabels(posUs);
    }

    _setTimeLabels(posUs) {
        const posSec = posUs / 1e6;
        this._elapsed.text = formatTime(posSec);
        this._remaining.text = this._length > 0 ? formatTime(posSec - this._length / 1e6) : '0:00';
    }

    _onSliderValue() {
        // Live feedback while the user is actually dragging; the seek itself
        // only fires once, on release (_commitSeek), so a fast drag does not
        // flood the engine with seeks.
        if (!this._scrubbing)
            return;
        this._setTimeLabels(this._slider.value * this._length);
    }

    _commitSeek() {
        if (this._length <= 0)
            return;
        this._player.seek(Math.round(this._slider.value * this._length));
    }

    _updateArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        this._artCancellable?.cancel();
        this._art.set_style('');
        if (!url)
            return;

        this._artCancellable = new Gio.Cancellable();
        const cancellable = this._artCancellable;
        cacheRemoteArt(url, cancellable).then(path => {
            if (this._destroyed || cancellable.is_cancelled() || this._artUrl !== url || !path)
                return;
            this._art.set_style(artStyle(path));
        });
    }

    // ------------------------------------------------------------------
    // Shuffle / repeat / engine actions
    // ------------------------------------------------------------------
    async _toggleShuffle() {
        this._shuffleBtn.reactive = false;
        try {
            const res = await amctl.run(['shuffle', 'toggle'], {cancellable: this._cancellable});
            if (res && typeof res.shuffle === 'boolean')
                this._shuffleBtn.checked = res.shuffle;
        } catch (e) {
            console.warn(`[Music Menu] PlayerBar shuffle toggle failed: ${e.message}`);
        } finally {
            if (!this._destroyed)
                this._shuffleBtn.reactive = true;
        }
    }

    async _cycleRepeat() {
        this._repeatBtn.reactive = false;
        try {
            const res = await amctl.run(['repeat', 'cycle'], {cancellable: this._cancellable});
            if (res && res.repeat) {
                let rep = String(res.repeat).toLowerCase();
                if (rep === 'off')
                    rep = 'none';
                this._repeatBtn.checked = rep !== 'none';
                this._repeatBtn.icon_name = rep === 'one'
                    ? 'media-playlist-repeat-song-symbolic'
                    : 'media-playlist-repeat-symbolic';
            }
        } catch (e) {
            console.warn(`[Music Menu] PlayerBar repeat cycle failed: ${e.message}`);
        } finally {
            if (!this._destroyed)
                this._repeatBtn.reactive = true;
        }
    }

    async _startEngine() {
        this._startButton.reactive = false;
        this._startButton.label = 'Starting…';
        try {
            await amctl.run(['engine', 'start'], {cancellable: this._cancellable});
        } catch (e) {
            console.warn(`[Music Menu] engine start failed: ${e.message}`);
        } finally {
            if (!this._destroyed) {
                this._startButton.reactive = true;
                this._startButton.label = 'Start Apple Music';
                this._checkEngine();
            }
        }
    }

    async _checkEngine() {
        if (this._destroyed)
            return;
        try {
            const res = await amctl.run(['engine', 'status'], {cancellable: this._cancellable});
            if (this._destroyed)
                return;
            this._engineRunning = !!res?.running;
        } catch {
            if (this._destroyed)
                return;
            this._engineRunning = false;
        }
        if (!this._player.state.track) {
            this._empty.visible = this._engineRunning !== false;
            this._startButton.visible = this._engineRunning === false;
        }
    }

    _scheduleEngineCheck() {
        if (this._engineCheckId || this._destroyed)
            return;
        this._checkEngine();
        this._engineCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ENGINE_POLL_MS, () => {
            if (this._destroyed || this._player.state.track) {
                this._engineCheckId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._checkEngine();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopEngineCheck() {
        if (this._engineCheckId) {
            GLib.source_remove(this._engineCheckId);
            this._engineCheckId = 0;
        }
    }

    // ------------------------------------------------------------------
    // Destruction
    // ------------------------------------------------------------------
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._stopEngineCheck();
        this._artCancellable?.cancel();
        this._cancellable.cancel();

        if (this._changedId)
            this._player.disconnect(this._changedId);
        if (this._positionId)
            this._player.disconnect(this._positionId);

        this._actor.destroy();
    }
}
