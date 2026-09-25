// The full now-playing view: big art, title, artist and album, the shared
// transport and scrubber (playerWidgets.js), and two tabs — time-synced
// Lyrics and the Up Next queue — each fetched from am.py when it is wanted
// rather than kept warm, since a view that is not open is not worth polling.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import * as amctl from './amctl.js';
import {createLabel} from './widgets.js';
import {findLyricIndex} from './playerUtil.js';
import {Transport, createRemoteArt} from './playerWidgets.js';

// A track is the same one for the queue's and lyrics' purposes if its
// catalog id, library id and title all still agree; anything looser risks
// missing a real change (a station looping the same title, say).
function trackKey(track) {
    return track ? `${track.catalogId || ''}|${track.id || ''}|${track.title || ''}` : null;
}

export class NowPlayingView {
    constructor({player}) {
        this._player = player;
        this._cancellable = new Gio.Cancellable();
        this._tab = 'lyrics';
        // The track each pane was last fetched for, and a token so a late
        // answer for an earlier one is dropped.
        this._lyricsKey = undefined;
        this._lyricsToken = 0;
        this._lines = [];
        this._lineActors = [];
        this._lineIndex = -1;
        this._queueKey = undefined;
        this._queueToken = 0;

        this.actor = new St.BoxLayout({
            style_class: 'mm-now-playing',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._art = createRemoteArt({styleClass: 'mm-now-playing-art', size: 240});
        this.actor.add_child(this._art);

        const meta = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-now-playing-meta',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._title = createLabel('', 'mm-now-playing-title', {x_align: Clutter.ActorAlign.CENTER});
        this._artist = createLabel('', 'mm-now-playing-artist', {x_align: Clutter.ActorAlign.CENTER});
        this._album = createLabel('', 'mm-now-playing-album', {x_align: Clutter.ActorAlign.CENTER});
        for (const label of [this._title, this._artist, this._album])
            meta.add_child(label);
        this.actor.add_child(meta);

        this._transport = new Transport({player, prefix: 'mm-now-playing'});
        this._transport.actor.add_style_class_name('mm-now-playing-controls');
        this.actor.add_child(this._transport.actor);

        const tabs = new St.BoxLayout({style_class: 'mm-now-playing-tabs', x_align: Clutter.ActorAlign.CENTER});
        this._lyricsTab = new St.Button({style_class: 'mm-now-playing-tab', label: 'Lyrics', can_focus: true, track_hover: true, checked: true});
        this._queueTab = new St.Button({style_class: 'mm-now-playing-tab', label: 'Up Next', can_focus: true, track_hover: true});
        this._lyricsTab.connect('clicked', () => this._selectTab('lyrics'));
        this._queueTab.connect('clicked', () => this._selectTab('queue'));
        tabs.add_child(this._lyricsTab);
        tabs.add_child(this._queueTab);
        this.actor.add_child(tabs);

        // Lyrics: a scrollable stack of lines, or an empty state.
        this._lyricsScroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'mm-lyrics-scroll'});
        this._lyricsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._lyricsBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-lyrics-box'});
        this._lyricsScroll.set_child(this._lyricsBox);
        this._lyricsEmpty = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-lyrics-empty',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._lyricsEmpty.add_child(new St.Label({text: 'No Lyrics', x_align: Clutter.ActorAlign.CENTER}));

        // Up Next: a plain scrollable list of rows.
        this._queueScroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'mm-queue-scroll', visible: false});
        this._queueScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._queueList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-queue-list'});
        this._queueScroll.set_child(this._queueList);

        this.actor.add_child(this._lyricsScroll);
        this.actor.add_child(this._lyricsEmpty);
        this.actor.add_child(this._queueScroll);

        player.connectObject(
            'changed', () => this._render(),
            'position', (_player, positionUs) => this._highlightLine(positionUs),
            this);
        this._render();
    }

    _render() {
        const track = this._player.state.track;
        this._title.text = track?.title || 'Not Playing';
        this._artist.text = track?.artist ?? '';
        this._album.text = track?.album ?? '';
        this._art.setUrl(track?.artUrl ?? null);

        const key = trackKey(track);
        if (key !== this._lyricsKey)
            this._fetchLyrics(track);
        if (this._tab === 'queue' && key !== this._queueKey)
            this._fetchQueue();
    }

    _selectTab(name) {
        if (this._tab === name)
            return;
        this._tab = name;
        this._lyricsTab.checked = name === 'lyrics';
        this._queueTab.checked = name === 'queue';
        this._showPane();
        if (name === 'queue' && trackKey(this._player.state.track) !== this._queueKey)
            this._fetchQueue();
        else if (name === 'lyrics')
            this._scrollToLine();
    }

    _showPane() {
        const lyrics = this._tab === 'lyrics';
        this._lyricsScroll.visible = lyrics && this._lines.length > 0;
        this._lyricsEmpty.visible = lyrics && this._lines.length === 0;
        this._queueScroll.visible = !lyrics;
    }

    // ------------------------------------------------------------------
    // Lyrics
    // ------------------------------------------------------------------
    async _fetchLyrics(track) {
        this._lyricsKey = trackKey(track);
        const token = ++this._lyricsToken;
        let lines = [];
        if (track?.catalogId) {
            try {
                const res = await amctl.run(['lyrics', track.catalogId], {cancellable: this._cancellable});
                lines = Array.isArray(res.lines) ? res.lines : [];
            } catch {
                // No lyrics for this one, or the engine is down: the empty state.
            }
        }
        if (token === this._lyricsToken && !this._destroyed)
            this._setLyrics(lines);
    }

    _setLyrics(lines) {
        this._lyricsBox.destroy_all_children();
        this._lines = lines;
        this._lineActors = [];
        this._lineIndex = -1;
        for (const line of lines) {
            const label = new St.Label({text: line.text, x_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            const row = new St.Button({style_class: 'mm-lyric-line', can_focus: true, track_hover: true, x_expand: true, child: label});
            row.connect('clicked', () => this._player.seek(Math.max(0, Number(line.startMs) || 0) * 1000));
            this._lyricsBox.add_child(row);
            this._lineActors.push(row);
        }
        this._showPane();
        this._highlightLine(this._player.state.positionUs);
    }

    _highlightLine(positionUs) {
        if (!this._lines.length)
            return;
        const index = findLyricIndex(this._lines, positionUs / 1000);
        if (index === this._lineIndex)
            return;
        this._lineActors[this._lineIndex]?.remove_style_class_name('mm-lyric-line-active');
        this._lineIndex = index;
        this._lineActors[index]?.add_style_class_name('mm-lyric-line-active');
        if (this._tab === 'lyrics')
            this._scrollToLine();
    }

    _scrollToLine() {
        const actor = this._lineActors[this._lineIndex];
        if (actor)
            ensureActorVisibleInScrollView(this._lyricsScroll, actor);
    }

    // ------------------------------------------------------------------
    // Up Next
    // ------------------------------------------------------------------
    async _fetchQueue() {
        this._queueKey = trackKey(this._player.state.track);
        const token = ++this._queueToken;
        let items = [];
        let index = -1;
        try {
            const res = await amctl.run(['queue'], {cancellable: this._cancellable});
            items = Array.isArray(res.items) ? res.items : [];
            index = typeof res.index === 'number' ? res.index : -1;
        } catch {
            // The engine is down: an empty list.
        }
        if (token === this._queueToken && !this._destroyed)
            this._setQueue(items, index);
    }

    _setQueue(items, activeIndex) {
        this._queueList.destroy_all_children();
        items.forEach((item, index) => {
            const row = new St.Button({
                style_class: index === activeIndex ? 'mm-queue-item mm-queue-item-active' : 'mm-queue-item',
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });
            const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(createLabel(item.title ?? '', 'mm-queue-item-title'));
            if (item.artist)
                text.add_child(createLabel(item.artist, 'mm-queue-item-artist'));
            content.add_child(text);
            if (item.durationLabel)
                content.add_child(new St.Label({text: item.durationLabel, style_class: 'mm-queue-item-duration', y_align: Clutter.ActorAlign.CENTER}));
            row.set_child(content);
            if (item.id)
                row.connect('clicked', () => amctl.fire(['play', 'song', item.id]));
            this._queueList.add_child(row);
        });
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancellable.cancel();
        this._player.disconnectObject(this);
        this._transport.destroy();
        this.actor.destroy();
    }
}
