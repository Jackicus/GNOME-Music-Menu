// What the player bar and the now-playing view have in common: the
// transport row (shuffle, previous, play/pause, next, repeat) over a scrubber
// with the elapsed and remaining time, and a square of cover art fetched from
// the URL MPRIS hands over. Both follow one Player's 'changed' and 'position'
// signals directly, so a view only places them. One set of stylesheet
// classes (`mm-transport*`, `mm-scrubber`, `mm-time`) serves both; `large`
// adds `mm-transport-large`, the now-playing view's size up.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {createIconButton} from './widgets.js';
import {formatTime, cacheRemoteArt} from './playerUtil.js';

const REPEAT_ICON = {
    none: 'media-playlist-repeat-symbolic',
    all: 'media-playlist-repeat-symbolic',
    one: 'media-playlist-repeat-song-symbolic',
};

export class Transport {
    constructor({player, large = false}) {
        this._player = player;
        this._scrubbing = false;
        this._lengthUs = 0;

        // In the bar the transport takes what the lockup leaves, so the
        // scrubber runs the width of the card; under the now-playing view's
        // artwork it sits centred at its own width.
        this.actor = new St.BoxLayout({
            style_class: large ? 'mm-transport mm-transport-large' : 'mm-transport',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: large ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const button = (icon, name, styleClass = 'icon-button mm-transport-btn') =>
            createIconButton(icon, {styleClass, accessibleName: name});
        this._shuffle = button('media-playlist-shuffle-symbolic', 'Shuffle');
        this._previous = button('media-skip-backward-symbolic', 'Previous');
        this._play = button('media-playback-start-symbolic', 'Play', 'icon-button mm-transport-play');
        this._next = button('media-skip-forward-symbolic', 'Next');
        this._repeat = button('media-playlist-repeat-symbolic', 'Repeat');
        // A horizontal box stretches its children to its height, which pulls
        // these round icon-buttons into pills; keep them their natural square.
        for (const b of [this._shuffle, this._previous, this._next, this._repeat])
            b.y_align = Clutter.ActorAlign.CENTER;
        this._shuffle.connect('clicked', () => this._toggle(this._shuffle, player.toggleShuffle()));
        this._previous.connect('clicked', () => player.previous());
        this._play.connect('clicked', () => player.playPause());
        this._next.connect('clicked', () => player.next());
        this._repeat.connect('clicked', () => this._toggle(this._repeat, player.cycleRepeat()));

        const row = new St.BoxLayout({style_class: 'mm-transport-row', x_align: Clutter.ActorAlign.CENTER});
        for (const b of [this._shuffle, this._previous, this._play, this._next, this._repeat])
            row.add_child(b);
        this.actor.add_child(row);

        // Live feedback on the labels while dragging; the seek itself fires
        // once, on release, so a fast drag does not flood the engine.
        const scrubber = new St.BoxLayout({style_class: 'mm-scrubber', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._elapsed = new St.Label({style_class: 'mm-time', text: '0:00'});
        this._remaining = new St.Label({style_class: 'mm-time', text: '0:00'});
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.connect('drag-begin', () => (this._scrubbing = true));
        this._slider.connect('drag-end', () => {
            this._scrubbing = false;
            if (this._lengthUs > 0)
                player.seek(Math.round(this._slider.value * this._lengthUs));
        });
        this._slider.connect('notify::value', () => {
            if (this._scrubbing)
                this._setTimes(this._slider.value * this._lengthUs);
        });
        scrubber.add_child(this._elapsed);
        scrubber.add_child(this._slider);
        scrubber.add_child(this._remaining);
        this.actor.add_child(scrubber);

        player.connectObject(
            'changed', () => this._render(),
            'position', (_player, positionUs) => this._setPosition(positionUs),
            this);
        this._render();
    }

    // The button is held off until the engine has answered, so a double
    // click does not toggle twice.
    async _toggle(button, promise) {
        button.reactive = false;
        try {
            await promise;
        } finally {
            button.reactive = true;
        }
    }

    _render() {
        const state = this._player.state;
        this._lengthUs = state.track?.lengthUs ?? 0;
        const playing = state.status === 'Playing';
        this._play.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.accessible_name = playing ? 'Pause' : 'Play';
        this._previous.reactive = state.canPrevious;
        this._next.reactive = state.canNext;
        this._slider.reactive = state.canSeek;
        this._shuffle.checked = state.shuffle;
        this._repeat.checked = state.repeat !== 'none';
        this._repeat.icon_name = REPEAT_ICON[state.repeat];
        this._setPosition(state.positionUs);
    }

    _setPosition(positionUs) {
        if (this._scrubbing)
            return;
        this._slider.value = this._lengthUs > 0 ? Math.min(1, positionUs / this._lengthUs) : 0;
        this._setTimes(positionUs);
    }

    _setTimes(positionUs) {
        const seconds = positionUs / 1e6;
        this._elapsed.text = formatTime(seconds);
        this._remaining.text = this._lengthUs > 0 ? formatTime(seconds - this._lengthUs / 1e6) : '0:00';
    }

    destroy() {
        this._player.disconnectObject(this);
        this.actor.destroy();
    }
}

// A square that shows the cover at `url` once it is in the local cache
// (playerUtil.js `cacheRemoteArt`) — drawn as a background image, the way
// every other piece of artwork in the app is — and nothing while there is
// none. `setUrl(url)` is attached to the widget; a URL that changes while a
// fetch is still out cancels it.
export function createRemoteArt({styleClass, size}) {
    const art = new St.Widget({
        style_class: styleClass,
        layout_manager: new Clutter.BinLayout(),
        width: size,
        height: size,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    let current;
    let cancellable = null;
    art.setUrl = url => {
        if (url === current)
            return;
        current = url;
        cancellable?.cancel();
        cancellable = null;
        art.set_style('');
        if (!url)
            return;
        cancellable = new Gio.Cancellable();
        cacheRemoteArt(url, cancellable).then(path => {
            if (path && current === url)
                art.set_style(`background-image: url("file://${encodeURI(path)}"); background-size: cover;`);
        });
    };
    art.connect('destroy', () => cancellable?.cancel());
    return art;
}
