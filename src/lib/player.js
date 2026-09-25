// Player: follows the engine's MPRIS player (Chrome's media session at
// music.apple.com) and exposes playback state, transport controls, and
// position updates for the player bar and now-playing views.
//
// MPRIS tells us when playback starts, stops, or changes track, but does not
// announce Position continuously. We reckon the position locally with the
// monotonic clock while playing, corrected on pause, seek, and track change.
// When MPRIS properties (Shuffle, LoopStatus) are absent from Chrome, we fall
// back to amctl.run(['now-playing']).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import * as amctl from './amctl.js';
import {parseMprisMetadata, parseCatalogId} from './playerUtil.js';

const MPRIS_NAMESPACE = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';

const clockUs = () => GLib.get_monotonic_time();

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Read the engine's PID from $XDG_RUNTIME_DIR/music-menu/engine.json if present.
function readEnginePid() {
    try {
        const runtimeDir = GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_user_runtime_dir();
        const path = GLib.build_filenamev([runtimeDir, 'music-menu', 'engine.json']);
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        const text = new TextDecoder('utf-8').decode(bytes);
        const data = JSON.parse(text);
        return typeof data?.pid === 'number' ? data.pid : null;
    } catch {
        return null;
    }
}

export class Player extends Signals.EventEmitter {
    constructor() {
        super();

        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;

        // MPRIS tracking
        this._subscriptions = [];
        this._owner = null;       // unique bus name, e.g. ':1.123'
        this._busName = null;     // well-known name, e.g. 'org.mpris.MediaPlayer2.chrome.instance...'
        this._knownOwners = new Map(); // busName -> owner

        // Playback state
        this._status = 'Stopped'; // 'Playing' | 'Paused' | 'Stopped'
        this._track = null;       // {title, artist, album, artUrl, lengthUs, catalogId, id, trackId} or null
        this._positionUs = 0;     // integer microseconds at last read time
        this._readAtUs = clockUs();
        this._rate = 1.0;
        this._lengthUs = 0;
        this._canNext = false;
        this._canPrevious = false;
        this._canSeek = false;
        this._shuffle = false;
        this._repeat = 'none';    // 'none' | 'one' | 'all'

        // Shuffle / Repeat detection & amctl fallback
        this._hasMprisShuffle = false;
        this._hasMprisLoopStatus = false;
        this._lastAmNowPlayingTime = 0;
        this._lastTrackKey = null;
        this._fetchingNowPlaying = false;

        // Position ticking timer (~1000ms while Playing)
        this._positionTimerId = 0;

        this._initBus();
    }

    get state() {
        return {
            status: this._status,
            track: this._track ? {
                title: this._track.title,
                artist: this._track.artist,
                album: this._track.album,
                artUrl: this._track.artUrl,
                lengthUs: this._track.lengthUs,
                catalogId: this._track.catalogId,
                id: this._track.id,
            } : null,
            positionUs: this._currentPositionUs(),
            canNext: this._canNext,
            canPrevious: this._canPrevious,
            canSeek: this._canSeek,
            shuffle: this._shuffle,
            repeat: this._repeat,
        };
    }

    // ------------------------------------------------------------------
    // D-Bus setup & lifecycle
    // ------------------------------------------------------------------
    _initBus() {
        if (!this._bus)
            return;

        // 1. Follow MPRIS owners coming and going
        const ownerSubId = this._bus.signal_subscribe(
            DBUS_IFACE,
            DBUS_IFACE,
            'NameOwnerChanged',
            DBUS_PATH,
            MPRIS_NAMESPACE,
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            this._onNameOwnerChanged.bind(this)
        );
        this._subscriptions.push(ownerSubId);

        // 2. Follow property changes across media players
        const propsSubId = this._bus.signal_subscribe(
            null,
            PROPERTIES_IFACE,
            'PropertiesChanged',
            MPRIS_PATH,
            PLAYER_IFACE,
            Gio.DBusSignalFlags.NONE,
            this._onPropertiesChanged.bind(this)
        );
        this._subscriptions.push(propsSubId);

        // 3. Follow seek events
        const seekedSubId = this._bus.signal_subscribe(
            null,
            PLAYER_IFACE,
            'Seeked',
            MPRIS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onSeeked.bind(this)
        );
        this._subscriptions.push(seekedSubId);

        // Discover players already running
        this._checkExistingNames();
    }

    _checkExistingNames() {
        this._bus.call(
            DBUS_IFACE,
            DBUS_PATH,
            DBUS_IFACE,
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                if (this._destroyed)
                    return;
                let names;
                try {
                    [names] = bus.call_finish(res).deep_unpack();
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`[Music Menu] Could not list media players: ${e.message}`);
                    return;
                }
                const mprisNames = names.filter(n => n.startsWith(`${MPRIS_NAMESPACE}.`));
                for (const name of mprisNames)
                    this._resolveNameOwner(name);
            }
        );
    }

    _resolveNameOwner(name) {
        this._bus.call(
            DBUS_IFACE,
            DBUS_PATH,
            DBUS_IFACE,
            'GetNameOwner',
            new GLib.Variant('(s)', [name]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                if (this._destroyed)
                    return;
                try {
                    const [owner] = bus.call_finish(res).deep_unpack();
                    this._onNameDiscovered(name, owner);
                } catch {
                    // Name vanished before we could inspect it
                }
            }
        );
    }

    _onNameOwnerChanged(_bus, _sender, _path, _iface, _signal, params) {
        if (this._destroyed)
            return;
        const [name, oldOwner, newOwner] = params.deep_unpack();
        if (!name.startsWith(`${MPRIS_NAMESPACE}.`))
            return;

        if (oldOwner) {
            this._knownOwners.delete(name);
            if (this._owner === oldOwner || this._busName === name)
                this._clearPlayer();
        }

        if (newOwner)
            this._onNameDiscovered(name, newOwner);
    }

    _onNameDiscovered(name, owner) {
        this._knownOwners.set(name, owner);

        if (this._owner === owner)
            return;

        // a) Check if engine.json exists and owner PID matches
        const enginePid = readEnginePid();
        if (enginePid !== null) {
            this._getProcessPid(owner, pid => {
                if (this._destroyed)
                    return;
                if (pid !== null && pid === enginePid) {
                    this._attachToPlayer(owner, name);
                    return;
                }
                // PID did not match: fallback to inspecting metadata (b)
                if (!this._owner)
                    this._checkMetadataFallback(owner, name);
            });
        } else {
            // b) Failing that, check if xesam:url or mpris:trackid contains music.apple.com
            if (!this._owner)
                this._checkMetadataFallback(owner, name);
        }
    }

    _getProcessPid(owner, callback) {
        this._bus.call(
            DBUS_IFACE,
            DBUS_PATH,
            DBUS_IFACE,
            'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [owner]),
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                if (this._destroyed)
                    return;
                let pid = null;
                try {
                    [pid] = bus.call_finish(res).deep_unpack();
                } catch {
                    callback(null);
                    return;
                }
                callback(pid);
            }
        );
    }

    _checkMetadataFallback(owner, name) {
        this._bus.call(
            owner,
            MPRIS_PATH,
            PROPERTIES_IFACE,
            'GetAll',
            new GLib.Variant('(s)', [PLAYER_IFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                if (this._destroyed || this._owner)
                    return;
                let props;
                try {
                    [props] = bus.call_finish(res).recursiveUnpack();
                } catch {
                    return;
                }
                const meta = props?.Metadata ?? {};
                const url = String(meta['xesam:url'] || '');
                const trackId = String(meta['mpris:trackid'] || '');
                if (url.includes('music.apple.com') || trackId.includes('music.apple.com'))
                    this._attachToPlayer(owner, name, props);
            }
        );
    }

    _attachToPlayer(owner, busName, initialProps = null) {
        this._owner = owner;
        this._busName = busName;

        this._fetchAllProperties(owner, initialProps);
    }

    _fetchAllProperties(owner, initialProps = null) {
        this._bus.call(
            owner,
            MPRIS_PATH,
            PROPERTIES_IFACE,
            'GetAll',
            new GLib.Variant('(s)', [PLAYER_IFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                if (this._destroyed || this._owner !== owner)
                    return;
                try {
                    const [props] = bus.call_finish(res).recursiveUnpack();
                    this._applyProperties(props);
                } catch (e) {
                    if (!isCancelled(e) && initialProps)
                        this._applyProperties(initialProps);
                }
            }
        );
    }

    _clearPlayer() {
        this._owner = null;
        this._busName = null;
        this._stopPositionTimer();

        this._status = 'Stopped';
        this._track = null;
        this._positionUs = 0;
        this._readAtUs = clockUs();
        this._rate = 1.0;
        this._lengthUs = 0;
        this._canNext = false;
        this._canPrevious = false;
        this._canSeek = false;
        this._shuffle = false;
        this._repeat = 'none';
        this._hasMprisShuffle = false;
        this._hasMprisLoopStatus = false;
        this._lastTrackKey = null;

        this.emit('changed');
        this.emit('position', 0);
    }

    // ------------------------------------------------------------------
    // Property updates & signal listeners
    // ------------------------------------------------------------------
    _onPropertiesChanged(_bus, sender, _path, _iface, _signal, params) {
        if (this._destroyed)
            return;

        let changedProps;
        try {
            [, changedProps] = params.recursiveUnpack();
        } catch {
            return;
        }

        if (this._owner && sender === this._owner) {
            this._applyProperties(changedProps);
            return;
        }

        // If we don't have an active player yet, see if this sender is playing music.apple.com
        if (!this._owner) {
            const meta = changedProps?.Metadata ?? {};
            const url = String(meta['xesam:url'] || '');
            const trackId = String(meta['mpris:trackid'] || '');
            if (url.includes('music.apple.com') || trackId.includes('music.apple.com')) {
                let busName = null;
                for (const [name, owner] of this._knownOwners.entries()) {
                    if (owner === sender) {
                        busName = name;
                        break;
                    }
                }
                this._attachToPlayer(sender, busName, changedProps);
            }
        }
    }

    _onSeeked(_bus, sender, _path, _iface, _signal, params) {
        if (this._destroyed || sender !== this._owner)
            return;

        try {
            const [posUs] = params.recursiveUnpack();
            this._readPositionUs(Number(posUs));
            this.emit('changed');
            this.emit('position', this.state.positionUs);
        } catch {
            // ignore
        }
    }

    _applyProperties(props) {
        if (!props || typeof props !== 'object')
            return;

        let changed = false;
        let trackChanged = false;

        // 1. Playback rate
        if ('Rate' in props) {
            this._settle();
            const rate = Number(props.Rate);
            this._rate = rate > 0 && !isNaN(rate) ? rate : 1.0;
        }

        // 2. Control capabilities
        if ('CanGoNext' in props) {
            const canNext = !!props.CanGoNext;
            if (this._canNext !== canNext) {
                this._canNext = canNext;
                changed = true;
            }
        }
        if ('CanGoPrevious' in props) {
            const canPrevious = !!props.CanGoPrevious;
            if (this._canPrevious !== canPrevious) {
                this._canPrevious = canPrevious;
                changed = true;
            }
        }
        if ('CanSeek' in props) {
            const canSeek = !!props.CanSeek;
            if (this._canSeek !== canSeek) {
                this._canSeek = canSeek;
                changed = true;
            }
        }

        // 3. Track metadata
        if ('Metadata' in props) {
            const meta = props.Metadata ?? {};
            const parsed = parseMprisMetadata(meta);
            if (parsed) {
                trackChanged = !this._track ||
                    this._track.title !== parsed.title ||
                    this._track.artist !== parsed.artist ||
                    this._track.album !== parsed.album ||
                    this._track.lengthUs !== parsed.lengthUs ||
                    this._track.trackId !== parsed.trackId ||
                    this._track.catalogId !== parsed.catalogId;

                if (trackChanged) {
                    this._track = {
                        title: parsed.title,
                        artist: parsed.artist,
                        album: parsed.album,
                        // Chrome's own temp-file art is its logo, not the cover; wait for the poll's.
                        artUrl: /\/\.com\.google\.Chrome\./.test(parsed.artUrl ?? '') ? null : parsed.artUrl,
                        lengthUs: parsed.lengthUs,
                        catalogId: parsed.catalogId,
                        id: parsed.catalogId ?? parsed.trackId ?? null,
                        trackId: parsed.trackId,
                    };
                    this._lengthUs = parsed.lengthUs;
                    this._readPositionUs(0);
                    changed = true;
                }
            } else if (this._track !== null) {
                this._track = null;
                this._lengthUs = 0;
                this._readPositionUs(0);
                changed = true;
                trackChanged = true;
            }
        }

        // 4. Playback status
        if ('PlaybackStatus' in props) {
            const status = props.PlaybackStatus;
            const normalized = (status === 'Playing' || status === 'Paused' || status === 'Stopped')
                ? status
                : 'Stopped';

            if (normalized !== this._status) {
                this._settle();
                const wasPlaying = this._status === 'Playing';
                this._status = normalized;
                changed = true;

                if (normalized === 'Playing') {
                    this._startPositionTimer();
                } else {
                    this._stopPositionTimer();
                    if (wasPlaying && normalized === 'Paused')
                        this._queryMprisPosition();
                }
            }
        }

        // If player is active but capabilities weren't explicitly supplied, infer sensible defaults
        if (!('CanGoNext' in props) && this._status !== 'Stopped' && !this._canNext) {
            this._canNext = true;
            this._canPrevious = true;
            this._canSeek = true;
            changed = true;
        }

        // 5. Position (when reported directly in properties)
        if ('Position' in props) {
            const posUs = Number(props.Position);
            if (!isNaN(posUs)) {
                this._readPositionUs(posUs);
                changed = true;
            }
        } else if (changed && !('Position' in props) && (this._status === 'Playing' || this._status === 'Paused')) {
            // Read exact position once if not provided in properties
            this._queryMprisPosition();
        }

        // 6. Shuffle
        if ('Shuffle' in props) {
            this._hasMprisShuffle = true;
            const shuffle = !!props.Shuffle;
            if (this._shuffle !== shuffle) {
                this._shuffle = shuffle;
                changed = true;
            }
        }

        // 7. Loop / Repeat
        if ('LoopStatus' in props) {
            this._hasMprisLoopStatus = true;
            const loop = String(props.LoopStatus).toLowerCase();
            let repeat = 'none';
            if (loop === 'track')
                repeat = 'one';
            else if (loop === 'playlist')
                repeat = 'all';

            if (this._repeat !== repeat) {
                this._repeat = repeat;
                changed = true;
            }
        }

        if (changed) {
            this.emit('changed');
            this.emit('position', this.state.positionUs);
        }

        // Check if we need fallback now-playing poll for shuffle/repeat/id
        this._pollNowPlayingIfNeeded(trackChanged);
    }

    _queryMprisPosition() {
        if (!this._owner || !this._bus)
            return;
        this._bus.call(
            this._owner,
            MPRIS_PATH,
            PROPERTIES_IFACE,
            'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                if (this._destroyed)
                    return;
                try {
                    const [val] = bus.call_finish(res).recursiveUnpack();
                    const posUs = Number(val);
                    if (!isNaN(posUs)) {
                        this._readPositionUs(posUs);
                        this.emit('position', this.state.positionUs);
                    }
                } catch {
                    // Position property call failed or cancelled
                }
            }
        );
    }

    // ------------------------------------------------------------------
    // Position reckoning & timer
    // ------------------------------------------------------------------
    _currentPositionUs() {
        let pos = this._positionUs;
        if (this._status === 'Playing') {
            const elapsed = clockUs() - this._readAtUs;
            pos += Math.round(elapsed * this._rate);
        }
        pos = Math.max(0, pos);
        if (this._lengthUs > 0)
            pos = Math.min(pos, this._lengthUs);
        return Math.round(pos);
    }

    _settle() {
        this._readPositionUs(this._currentPositionUs());
    }

    _readPositionUs(posUs) {
        this._positionUs = Math.max(0, Math.round(posUs));
        if (this._lengthUs > 0)
            this._positionUs = Math.min(this._positionUs, this._lengthUs);
        this._readAtUs = clockUs();
    }

    _startPositionTimer() {
        if (this._positionTimerId)
            return;

        this._positionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._destroyed || this._status !== 'Playing') {
                this._positionTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            this.emit('position', this.state.positionUs);

            // Periodic poll for shuffle/repeat if MPRIS does not provide them
            if (!this._hasMprisShuffle || !this._hasMprisLoopStatus) {
                const now = GLib.get_monotonic_time() / 1000;
                if (now - this._lastAmNowPlayingTime >= 10000)
                    this._pollNowPlayingIfNeeded(false);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPositionTimer() {
        if (this._positionTimerId) {
            GLib.source_remove(this._positionTimerId);
            this._positionTimerId = 0;
        }
    }

    // ------------------------------------------------------------------
    // Fallback now-playing poll for shuffle, repeat, and track id
    // ------------------------------------------------------------------
    async _pollNowPlayingIfNeeded(force = false) {
        if (this._fetchingNowPlaying || this._destroyed)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const trackKey = this._track
            ? (this._track.catalogId || this._track.trackId || this._track.title)
            : null;
        const trackChanged = trackKey !== this._lastTrackKey;

        if (!force && !trackChanged && (now - this._lastAmNowPlayingTime < 10000))
            return;

        this._lastTrackKey = trackKey;
        this._lastAmNowPlayingTime = now;
        this._fetchingNowPlaying = true;

        try {
            const res = await amctl.run(['now-playing'], {cancellable: this._cancellable});
            if (this._destroyed)
                return;
            if (res) {
                let changed = false;

                if (typeof res.shuffle === 'boolean' && !this._hasMprisShuffle) {
                    if (this._shuffle !== res.shuffle) {
                        this._shuffle = res.shuffle;
                        changed = true;
                    }
                }

                if (res.repeat && !this._hasMprisLoopStatus) {
                    let rep = String(res.repeat).toLowerCase();
                    if (rep === 'off')
                        rep = 'none';
                    if (['none', 'one', 'all'].includes(rep) && this._repeat !== rep) {
                        this._repeat = rep;
                        changed = true;
                    }
                }

                if (res.track && this._track) {
                    if (res.track.id && this._track.id !== res.track.id) {
                        this._track.id = res.track.id;
                        changed = true;
                    }
                    if (res.track.catalogId && !this._track.catalogId) {
                        this._track.catalogId = res.track.catalogId;
                        changed = true;
                    }
                    // Apple's own cover beats whatever MPRIS offered: headless
                    // Chrome's media session art is the Chrome logo.
                    if (res.track.artUrl && this._track.artUrl !== res.track.artUrl) {
                        this._track.artUrl = res.track.artUrl;
                        changed = true;
                    }
                } else if (res.track && !this._track && (res.state === 'playing' || res.state === 'paused')) {
                    // MPRIS is reporting a status but stayed silent on Metadata
                    // (seen right after a track change on some players): fill
                    // the track in from the poll, position included, so the
                    // scrubber does not start from wherever it last was.
                    const durUs = Math.round((Number(res.track.durationMs) || 0) * 1000);
                    this._track = {
                        title: res.track.title || '',
                        artist: res.track.artist || '',
                        album: res.track.album || '',
                        artUrl: res.track.artUrl || null,
                        lengthUs: durUs,
                        catalogId: res.track.catalogId || null,
                        id: res.track.id || res.track.catalogId || null,
                        trackId: null,
                    };
                    this._lengthUs = durUs;
                    this._readPositionUs(Math.round((Number(res.position) || 0) * 1e6));
                    changed = true;
                }

                if (changed)
                    this.emit('changed');
            }
        } catch {
            // amctl failed or cancelled
        } finally {
            this._fetchingNowPlaying = false;
        }
    }

    // ------------------------------------------------------------------
    // Transport controls (async, never throws into callers)
    // ------------------------------------------------------------------
    _callPlayerMethod(method, params = null, returnType = null) {
        return new Promise((resolve, reject) => {
            if (!this._bus || !this._owner) {
                reject(new Error('No active MPRIS player'));
                return;
            }
            this._bus.call(
                this._owner,
                MPRIS_PATH,
                PLAYER_IFACE,
                method,
                params,
                returnType,
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable,
                (bus, res) => {
                    try {
                        const result = bus.call_finish(res);
                        resolve(result);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _setMprisProperty(propName, variantVal) {
        return new Promise((resolve, reject) => {
            if (!this._bus || !this._owner) {
                reject(new Error('No active MPRIS player'));
                return;
            }
            this._bus.call(
                this._owner,
                MPRIS_PATH,
                PROPERTIES_IFACE,
                'Set',
                new GLib.Variant('(ssv)', [PLAYER_IFACE, propName, variantVal]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable,
                (bus, res) => {
                    try {
                        bus.call_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    // Every transport verb is the same shape: try the MPRIS method we are
    // already attached to, and fall back to am.py's own `control` command
    // (which reaches the engine even before an MPRIS owner has been found,
    // or if the MPRIS call itself is refused).
    async _transport(label, mprisMethod, amctlVerb) {
        try {
            if (this._owner)
                await this._callPlayerMethod(mprisMethod);
            else
                await amctl.run(['control', amctlVerb], {cancellable: this._cancellable});
        } catch {
            try {
                await amctl.run(['control', amctlVerb], {cancellable: this._cancellable});
            } catch (e) {
                console.warn(`[Music Menu] ${label} failed: ${e.message}`);
            }
        }
    }

    playPause() { return this._transport('playPause', 'PlayPause', 'toggle'); }
    next() { return this._transport('next', 'Next', 'next'); }
    previous() { return this._transport('previous', 'Previous', 'previous'); }
    play() { return this._transport('play', 'Play', 'play'); }
    pause() { return this._transport('pause', 'Pause', 'pause'); }
    stop() { return this._transport('stop', 'Stop', 'stop'); }

    async seek(positionUs) {
        const targetUs = Math.max(0, Math.round(positionUs));
        const currentUs = this._currentPositionUs();
        const offsetUs = targetUs - currentUs;

        // Reckon position locally right away for an immediate UI response
        this._readPositionUs(targetUs);
        this.emit('changed');
        this.emit('position', this.state.positionUs);

        try {
            let handled = false;
            if (this._owner) {
                const trackId = this._track?.trackId;
                const isObjectPath = trackId && trackId.startsWith('/') && !trackId.includes(' ');
                if (isObjectPath && trackId !== '/org/mpris/MediaPlayer2/TrackList/NoTrack') {
                    try {
                        await this._callPlayerMethod(
                            'SetPosition',
                            new GLib.Variant('(ox)', [trackId, targetUs])
                        );
                        handled = true;
                    } catch {
                        handled = false;
                    }
                }

                if (!handled) {
                    try {
                        await this._callPlayerMethod(
                            'Seek',
                            new GLib.Variant('(x)', [offsetUs])
                        );
                        handled = true;
                    } catch {
                        handled = false;
                    }
                }
            }

            if (!handled) {
                const seconds = Math.round(targetUs / 1e6);
                await amctl.run(['seek', String(seconds)], {cancellable: this._cancellable});
            }
        } catch (e) {
            console.warn(`[Music Menu] seek failed: ${e.message}`);
        }
    }

    async setShuffle(enabled) {
        const val = !!enabled;
        if (this._shuffle === val)
            return;
        try {
            if (this._hasMprisShuffle && this._owner) {
                try {
                    await this._setMprisProperty('Shuffle', new GLib.Variant('b', val));
                    this._shuffle = val;
                    this.emit('changed');
                    return;
                } catch {
                    // MPRIS refused the property; fall back to am.py below.
                }
            }
            const res = await amctl.run(['shuffle', val ? 'on' : 'off'], {cancellable: this._cancellable});
            if (res && typeof res.shuffle === 'boolean') {
                this._shuffle = res.shuffle;
                this.emit('changed');
            }
        } catch (e) {
            console.warn(`[Music Menu] setShuffle failed: ${e.message}`);
        }
    }

    async toggleShuffle() {
        // Chrome's MPRIS Shuffle can be set directly and read straight back,
        // so a plain negation is safe; without it, am.py's own "toggle" is
        // the one place that knows the current value.
        if (this._hasMprisShuffle && this._owner)
            return this.setShuffle(!this._shuffle);
        try {
            const res = await amctl.run(['shuffle', 'toggle'], {cancellable: this._cancellable});
            if (res && typeof res.shuffle === 'boolean') {
                this._shuffle = res.shuffle;
                this.emit('changed');
            }
        } catch (e) {
            console.warn(`[Music Menu] toggleShuffle failed: ${e.message}`);
        }
    }

    async setRepeat(mode) {
        let rep = String(mode).toLowerCase();
        if (rep === 'off')
            rep = 'none';
        if (!['none', 'one', 'all'].includes(rep))
            return;
        if (this._repeat === rep)
            return;
        try {
            if (this._hasMprisLoopStatus && this._owner) {
                const mprisVal = rep === 'one' ? 'Track' : (rep === 'all' ? 'Playlist' : 'None');
                try {
                    await this._setMprisProperty('LoopStatus', new GLib.Variant('s', mprisVal));
                    this._repeat = rep;
                    this.emit('changed');
                    return;
                } catch {
                    // MPRIS refused the property; fall back to am.py below.
                }
            }
            const res = await amctl.run(['repeat', rep], {cancellable: this._cancellable});
            if (res && res.repeat) {
                let r = String(res.repeat).toLowerCase();
                if (r === 'off')
                    r = 'none';
                if (['none', 'one', 'all'].includes(r)) {
                    this._repeat = r;
                    this.emit('changed');
                }
            }
        } catch (e) {
            console.warn(`[Music Menu] setRepeat failed: ${e.message}`);
        }
    }

    async cycleRepeat() {
        if (this._hasMprisLoopStatus && this._owner) {
            const nextRepeat = this._repeat === 'none' ? 'all' : (this._repeat === 'all' ? 'one' : 'none');
            return this.setRepeat(nextRepeat);
        }
        try {
            const res = await amctl.run(['repeat', 'cycle'], {cancellable: this._cancellable});
            if (res && res.repeat) {
                let rep = String(res.repeat).toLowerCase();
                if (rep === 'off')
                    rep = 'none';
                if (['none', 'one', 'all'].includes(rep)) {
                    this._repeat = rep;
                    this.emit('changed');
                }
            }
        } catch (e) {
            console.warn(`[Music Menu] cycleRepeat failed: ${e.message}`);
        }
    }

    toggleRepeat() {
        return this.cycleRepeat();
    }

    // ------------------------------------------------------------------
    // Destruction
    // ------------------------------------------------------------------
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._stopPositionTimer();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._bus) {
            for (const subId of this._subscriptions) {
                try {
                    this._bus.signal_unsubscribe(subId);
                } catch {
                    // ignore
                }
            }
            this._subscriptions = [];
            this._bus = null;
        }

        this._knownOwners.clear();
        this._owner = null;
        this._busName = null;
        this._track = null;
    }
}
