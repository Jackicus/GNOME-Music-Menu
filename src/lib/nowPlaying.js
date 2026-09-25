// The full now-playing view: big art, transport and a scrubber the same
// shape as the player bar's, and two tabs — time-synced Lyrics and the
// Up Next queue — each fetched from am.py on demand rather than kept
// warm, since a view that is not open is not worth polling for.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import * as amctl from './amctl.js';
import {createIconButton, createLabel} from './widgets.js';
import {formatTime, findLyricIndex, cacheRemoteArt} from './playerUtil.js';

function artStyle(path) {
    return `background-image: url("file://${encodeURI(path)}"); background-size: cover;`;
}

// A track is the same one for the queue/lyrics fetches' purposes if its
// catalog id, library id and title all still agree; anything looser risks
// missing a real change (a station looping the same title, say).
function trackKey(track) {
    return track ? `${track.catalogId || ''}|${track.id || ''}|${track.title || ''}` : null;
}

export class NowPlayingView {
    constructor({player}) {
        this._player = player;
        this._destroyed = false;

        this._cancellable = new Gio.Cancellable();
        this._artCancellable = null;
        this._artUrl = null;

        this._scrubbing = false;
        this._length = 0;

        this._activeTab = 'lyrics';

        this._lyricsKey = undefined;
        this._lyricsFetchToken = 0;
        this._lyricsLines = [];
        this._lyricLineActors = [];
        this._lyricIndex = -1;

        this._queueKey = undefined;
        this._queueFetchToken = 0;

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
        this._actor = new St.BoxLayout({
            style_class: 'mm-now-playing',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._art = new St.Widget({
            style_class: 'mm-now-playing-art',
            layout_manager: new Clutter.BinLayout(),
            width: 240,
            height: 240,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._actor.add_child(this._art);

        const meta = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-now-playing-meta',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._title = createLabel('', 'mm-now-playing-title', {x_align: Clutter.ActorAlign.CENTER});
        this._artist = createLabel('', 'mm-now-playing-artist', {x_align: Clutter.ActorAlign.CENTER});
        this._album = createLabel('', 'mm-now-playing-album', {x_align: Clutter.ActorAlign.CENTER});
        meta.add_child(this._title);
        meta.add_child(this._artist);
        meta.add_child(this._album);
        this._actor.add_child(meta);

        const controls = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-now-playing-controls',
        });

        const transport = new St.BoxLayout({style_class: 'mm-now-playing-transport', x_align: Clutter.ActorAlign.CENTER});
        this._shuffleBtn = createIconButton('media-playlist-shuffle-symbolic', {styleClass: 'icon-button mm-now-playing-btn', accessibleName: 'Shuffle'});
        this._prevBtn = createIconButton('media-skip-backward-symbolic', {styleClass: 'icon-button mm-now-playing-btn', accessibleName: 'Previous'});
        this._playBtn = createIconButton('media-playback-start-symbolic', {styleClass: 'icon-button mm-now-playing-play', accessibleName: 'Play'});
        this._nextBtn = createIconButton('media-skip-forward-symbolic', {styleClass: 'icon-button mm-now-playing-btn', accessibleName: 'Next'});
        this._repeatBtn = createIconButton('media-playlist-repeat-symbolic', {styleClass: 'icon-button mm-now-playing-btn', accessibleName: 'Repeat'});
        this._shuffleBtn.connect('clicked', () => this._toggleShuffle());
        this._prevBtn.connect('clicked', () => this._player.previous());
        this._playBtn.connect('clicked', () => this._player.playPause());
        this._nextBtn.connect('clicked', () => this._player.next());
        this._repeatBtn.connect('clicked', () => this._cycleRepeat());
        for (const button of [this._shuffleBtn, this._prevBtn, this._playBtn, this._nextBtn, this._repeatBtn])
            transport.add_child(button);
        controls.add_child(transport);

        const scrubberRow = new St.BoxLayout({style_class: 'mm-now-playing-scrubber', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._elapsed = new St.Label({style_class: 'mm-now-playing-time', text: '0:00'});
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
        this._remaining = new St.Label({style_class: 'mm-now-playing-time', text: '0:00'});
        scrubberRow.add_child(this._elapsed);
        scrubberRow.add_child(this._slider);
        scrubberRow.add_child(this._remaining);
        controls.add_child(scrubberRow);

        this._actor.add_child(controls);

        // Tabs
        const tabs = new St.BoxLayout({style_class: 'mm-now-playing-tabs', x_align: Clutter.ActorAlign.CENTER});
        this._lyricsTab = new St.Button({style_class: 'mm-now-playing-tab', label: 'Lyrics', can_focus: true, track_hover: true});
        this._queueTab = new St.Button({style_class: 'mm-now-playing-tab', label: 'Up Next', can_focus: true, track_hover: true});
        this._lyricsTab.connect('clicked', () => this._selectTab('lyrics'));
        this._queueTab.connect('clicked', () => this._selectTab('queue'));
        this._lyricsTab.checked = true;
        tabs.add_child(this._lyricsTab);
        tabs.add_child(this._queueTab);
        this._actor.add_child(tabs);

        // Lyrics pane: a scrollable stack of lines, or an empty state.
        this._lyricsScroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'mm-lyrics-scroll'});
        this._lyricsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._lyricsBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-lyrics-box'});
        this._lyricsScroll.set_child(this._lyricsBox);
        this._lyricsEmpty = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'mm-lyrics-empty',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._lyricsEmpty.add_child(new St.Label({text: 'No Lyrics', x_align: Clutter.ActorAlign.CENTER}));
        this._lyricsEmpty.hide();

        // Up Next pane: a plain scrollable list of rows.
        this._queueScroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'mm-queue-scroll'});
        this._queueScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._queueList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mm-queue-list'});
        this._queueScroll.set_child(this._queueList);
        this._queueScroll.hide();

        this._actor.add_child(this._lyricsScroll);
        this._actor.add_child(this._lyricsEmpty);
        this._actor.add_child(this._queueScroll);
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

        this._title.text = track?.title || 'Not Playing';
        this._artist.text = track?.artist || '';
        this._album.text = track?.album || '';
        this._updateArt(track?.artUrl || null);

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

        const key = trackKey(track);
        if (key !== this._lyricsKey)
            this._fetchLyrics(track);
        if (this._activeTab === 'queue' && key !== this._queueKey)
            this._fetchQueue();
    }

    _onPosition(posUs) {
        if (this._destroyed)
            return;
        if (!this._scrubbing)
            this._updatePosition(posUs);
        this._updateLyricHighlight(posUs);
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
    // Tabs
    // ------------------------------------------------------------------
    _selectTab(name) {
        if (this._activeTab === name)
            return;
        this._activeTab = name;
        this._lyricsTab.checked = name === 'lyrics';
        this._queueTab.checked = name === 'queue';

        const showLyrics = name === 'lyrics';
        const hasLines = this._lyricsLines.length > 0;
        this._lyricsScroll.visible = showLyrics && hasLines;
        this._lyricsEmpty.visible = showLyrics && !hasLines;
        this._queueScroll.visible = !showLyrics;

        if (name === 'queue' && trackKey(this._player.state.track) !== this._queueKey)
            this._fetchQueue();
        else if (showLyrics && this._lyricIndex >= 0)
            this._scrollToActiveLyric();
    }

    // ------------------------------------------------------------------
    // Lyrics
    // ------------------------------------------------------------------
    async _fetchLyrics(track) {
        const key = trackKey(track);
        this._lyricsKey = key;
        const token = ++this._lyricsFetchToken;

        const catalogId = track?.catalogId || null;
        if (!catalogId) {
            this._applyLyrics([]);
            return;
        }

        try {
            const res = await amctl.run(['lyrics', catalogId], {cancellable: this._cancellable});
            if (token !== this._lyricsFetchToken || this._destroyed)
                return;
            this._applyLyrics(Array.isArray(res?.lines) ? res.lines : []);
        } catch {
            if (token !== this._lyricsFetchToken || this._destroyed)
                return;
            this._applyLyrics([]);
        }
    }

    _applyLyrics(lines) {
        this._lyricsBox.destroy_all_children();
        this._lyricLineActors = [];
        this._lyricIndex = -1;
        this._lyricsLines = lines;

        for (const line of lines) {
            const label = new St.Label({text: line.text, x_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            const row = new St.Button({
                style_class: 'mm-lyric-line',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                child: label,
            });
            const startMs = Math.max(0, Number(line.startMs) || 0);
            row.connect('clicked', () => this._player.seek(startMs * 1000));
            this._lyricsBox.add_child(row);
            this._lyricLineActors.push(row);
        }

        const showLyrics = this._activeTab === 'lyrics';
        const hasLines = lines.length > 0;
        this._lyricsScroll.visible = showLyrics && hasLines;
        this._lyricsEmpty.visible = showLyrics && !hasLines;

        if (hasLines)
            this._updateLyricHighlight(this._player.state.positionUs);
    }

    _updateLyricHighlight(posUs) {
        if (!this._lyricsLines.length)
            return;
        const index = findLyricIndex(this._lyricsLines, posUs / 1000);
        if (index === this._lyricIndex)
            return;

        if (this._lyricIndex >= 0 && this._lyricLineActors[this._lyricIndex])
            this._lyricLineActors[this._lyricIndex].remove_style_class_name('mm-lyric-line-active');

        this._lyricIndex = index;
        if (index >= 0 && this._lyricLineActors[index]) {
            this._lyricLineActors[index].add_style_class_name('mm-lyric-line-active');
            if (this._activeTab === 'lyrics')
                this._scrollToActiveLyric();
        }
    }

    _scrollToActiveLyric() {
        const actor = this._lyricLineActors[this._lyricIndex];
        if (actor)
            ensureActorVisibleInScrollView(this._lyricsScroll, actor);
    }

    // ------------------------------------------------------------------
    // Up Next
    // ------------------------------------------------------------------
    async _fetchQueue() {
        const key = trackKey(this._player.state.track);
        this._queueKey = key;
        const token = ++this._queueFetchToken;

        try {
            const res = await amctl.run(['queue'], {cancellable: this._cancellable});
            if (token !== this._queueFetchToken || this._destroyed)
                return;
            this._applyQueue(Array.isArray(res?.items) ? res.items : [], typeof res?.index === 'number' ? res.index : -1);
        } catch {
            if (token !== this._queueFetchToken || this._destroyed)
                return;
            this._applyQueue([], -1);
        }
    }

    _applyQueue(items, activeIndex) {
        this._queueList.destroy_all_children();

        items.forEach((item, index) => {
            const row = new St.Button({
                style_class: index === activeIndex ? 'mm-queue-item mm-queue-item-active' : 'mm-queue-item',
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });
            const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(createLabel(item.title || '', 'mm-queue-item-title'));
            if (item.artist)
                text.add_child(createLabel(item.artist, 'mm-queue-item-artist'));
            content.add_child(text);
            if (item.durationLabel)
                content.add_child(new St.Label({text: item.durationLabel, style_class: 'mm-queue-item-duration', y_align: Clutter.ActorAlign.CENTER}));
            row.set_child(content);

            const songId = item.id;
            row.connect('clicked', () => {
                if (songId)
                    amctl.fire(['play', 'song', songId]);
            });
            this._queueList.add_child(row);
        });
    }

    // ------------------------------------------------------------------
    // Shuffle / repeat
    // ------------------------------------------------------------------
    async _toggleShuffle() {
        this._shuffleBtn.reactive = false;
        try {
            const res = await amctl.run(['shuffle', 'toggle'], {cancellable: this._cancellable});
            if (res && typeof res.shuffle === 'boolean')
                this._shuffleBtn.checked = res.shuffle;
        } catch (e) {
            console.warn(`[Music Menu] NowPlayingView shuffle toggle failed: ${e.message}`);
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
            console.warn(`[Music Menu] NowPlayingView repeat cycle failed: ${e.message}`);
        } finally {
            if (!this._destroyed)
                this._repeatBtn.reactive = true;
        }
    }

    // ------------------------------------------------------------------
    // Destruction
    // ------------------------------------------------------------------
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._artCancellable?.cancel();
        this._cancellable.cancel();

        if (this._changedId)
            this._player.disconnect(this._changedId);
        if (this._positionId)
            this._player.disconnect(this._positionId);

        this._actor.destroy();
    }
}
