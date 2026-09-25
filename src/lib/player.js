// Player: follows the engine's MPRIS player — Chrome's media session for
// music.apple.com — and gives the player bar and the now-playing view its
// state, the transport and a running position.
//
// Built the way the shell's own ui/mpris.js is: one proxy on the bus itself,
// to see players come and go (ListNames, NameOwnerChanged), and one
// Gio.DBusProxy wrapper on the player once it is found, whose property cache
// and `g-properties-changed` do the bookkeeping raw bus calls would. The
// engine's player is told from any other by PID — am.py writes the engine's
// into $XDG_RUNTIME_DIR/music-menu/engine.json — or, failing that, by its
// metadata naming music.apple.com.
//
// MPRIS announces play, pause and a track change, but not a running position,
// so the position is reckoned off the monotonic clock between corrections: a
// pause, a seek, a track change, and a read of Position at each. Chrome's
// MPRIS has no Shuffle or LoopStatus, so those, the catalog id and Apple's
// own cover art come from am.py's `now-playing` — once per track change and
// every ten seconds while playing — and shuffle and repeat are set through
// am.py alone.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import * as amctl from './amctl.js';
import {parseMprisMetadata} from './playerUtil.js';

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.DBus'));

// The shell's own copy of this interface stops at what its media section
// uses; the seek, rate and mode members are declared here.
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
<interface name="${PLAYER_IFACE}">
  <method name="PlayPause"/>
  <method name="Next"/>
  <method name="Previous"/>
  <method name="Seek"><arg type="x" direction="in"/></method>
  <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
  <signal name="Seeked"><arg type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="LoopStatus" type="s" access="readwrite"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="Rate" type="d" access="readwrite"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
</interface></node>`);

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
const POLL_INTERVAL_US = 10 * 1000 * 1000;

// am.py and MPRIS name the modes differently; one vocabulary here.
const REPEAT = {none: 'none', off: 'none', one: 'one', track: 'one', all: 'all', playlist: 'all'};
const repeatOf = value => REPEAT[String(value).toLowerCase()] ?? 'none';
const shuffleOf = value => value === true || value === 'on' || value === 'songs';

function readEnginePid() {
    const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'music-menu', 'engine.json']);
    try {
        const [, bytes] = GLib.file_get_contents(path);
        const pid = JSON.parse(new TextDecoder().decode(bytes))?.pid;
        return typeof pid === 'number' ? pid : null;
    } catch {
        return null;
    }
}

function isAppleMusic(meta) {
    return `${meta?.['xesam:url'] ?? ''} ${meta?.['mpris:trackid'] ?? ''}`.includes('music.apple.com');
}

// A proxy's cache as plain values: the property getters leave the values of
// Metadata's a{sv} as Variants.
function cachedProperties(proxy) {
    const props = {};
    for (const name of proxy.get_cached_property_names() ?? [])
        props[name] = proxy.get_cached_property(name).recursiveUnpack();
    return props;
}

function proxyFor(name, cancellable) {
    return new Promise((resolve, reject) => {
        new PlayerProxy(Gio.DBus.session, name, MPRIS_PATH,
            (proxy, error) => (error ? reject(error) : resolve(proxy)), cancellable);
    });
}

export class Player extends Signals.EventEmitter {
    constructor() {
        super();
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._proxy = null;
        this._seekedId = 0;
        this._considering = new Set();
        this._timer = 0;
        this._polling = false;
        this._polledAt = 0;
        this._reset();

        this._dbus = new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            (proxy, error) => {
                if (error) {
                    console.warn(`[Music Menu] Could not reach the session bus: ${error.message}`);
                    return;
                }
                proxy.ListNamesRemote(([names] = [[]]) => {
                    for (const name of names) {
                        if (name.startsWith(MPRIS_PREFIX))
                            this._consider(name);
                    }
                }, this._cancellable);
            }, this._cancellable);
        this._ownerId = this._dbus.connectSignal('NameOwnerChanged', (_proxy, _sender, [name, , newOwner]) => {
            if (newOwner && name.startsWith(MPRIS_PREFIX))
                this._consider(name);
        });
    }

    get state() {
        const track = this._track;
        return {
            status: this._status,
            track: track && {
                title: track.title, artist: track.artist, album: track.album, artUrl: track.artUrl,
                lengthUs: track.lengthUs, catalogId: track.catalogId, id: track.id,
            },
            positionUs: this._position(),
            // The engine can always skip and seek through am.py, whatever
            // Chrome's media session says it can do.
            canNext: !!track,
            canPrevious: !!track,
            canSeek: !!track && this._lengthUs > 0,
            shuffle: this._shuffle,
            repeat: this._repeat,
        };
    }

    // ------------------------------------------------------------------
    // Finding the engine's player
    // ------------------------------------------------------------------
    async _consider(name) {
        if (this._destroyed || this._considering.has(name) || this._proxy?.g_name === name)
            return;
        this._considering.add(name);
        try {
            const proxy = await proxyFor(name, this._cancellable);
            const [pid] = await this._dbus.GetConnectionUnixProcessIDAsync(name, this._cancellable);
            if (this._destroyed)
                return;
            const enginePid = readEnginePid();
            const isEngine = enginePid !== null && pid === enginePid;
            // Without a PID to go on, a player on music.apple.com will do —
            // but only if none has been found yet.
            if (isEngine || (!this._proxy && isAppleMusic(cachedProperties(proxy).Metadata)))
                this._attach(proxy);
        } catch {
            // Gone again before it could be asked, or we were.
        } finally {
            this._considering.delete(name);
        }
    }

    _attach(proxy) {
        this._detach();
        this._proxy = proxy;
        proxy.connectObject(
            'g-properties-changed', (_proxy, changed) => this._apply(changed.recursiveUnpack()),
            'notify::g-name-owner', () => {
                if (!proxy.g_name_owner)
                    this._detach();
            }, this);
        this._seekedId = proxy.connectSignal('Seeked', (_proxy, _sender, [positionUs]) => {
            this._correct(positionUs);
            this._emit();
        });
        this._apply(cachedProperties(proxy));
    }

    _detach() {
        const proxy = this._proxy;
        if (!proxy)
            return;
        proxy.disconnectObject(this);
        proxy.disconnectSignal(this._seekedId);
        this._proxy = null;
        this._stopTimer();
        this._reset();
        this._emit();
    }

    _reset() {
        this._status = 'Stopped';
        this._track = null;
        this._lengthUs = 0;
        this._rate = 1;
        this._shuffle = false;
        this._repeat = 'none';
        this._correct(0);
    }

    // ------------------------------------------------------------------
    // What MPRIS says
    // ------------------------------------------------------------------
    _apply(props) {
        let changed = false;
        let trackChanged = false;
        let statusChanged = false;

        if ('Rate' in props) {
            this._settle();
            this._rate = props.Rate > 0 ? props.Rate : 1;
        }

        if ('Metadata' in props) {
            const parsed = parseMprisMetadata(props.Metadata);
            const key = t => t && [t.title, t.artist, t.album, t.lengthUs, t.trackId].join('\n');
            if (key(parsed) !== key(this._track)) {
                trackChanged = changed = true;
                this._track = parsed && {
                    ...parsed,
                    // Headless Chrome's media-session art is its own logo, not
                    // the cover; the poll brings Apple's.
                    artUrl: /\/\.com\.google\.Chrome\./.test(parsed.artUrl ?? '') ? null : parsed.artUrl,
                    id: parsed.catalogId ?? parsed.trackId ?? null,
                };
                this._lengthUs = parsed?.lengthUs ?? 0;
                this._correct(0);
            }
        }

        if ('PlaybackStatus' in props) {
            const status = ['Playing', 'Paused'].includes(props.PlaybackStatus) ? props.PlaybackStatus : 'Stopped';
            if (status !== this._status) {
                statusChanged = changed = true;
                this._settle();
                this._status = status;
                if (status === 'Playing')
                    this._startTimer();
                else
                    this._stopTimer();
            }
        }

        if ('Position' in props)
            this._correct(props.Position);
        else if ((trackChanged || statusChanged) && this._status !== 'Stopped')
            this._readPosition();

        if ('Shuffle' in props)
            changed = this._setModes(shuffleOf(props.Shuffle), this._repeat) || changed;
        if ('LoopStatus' in props)
            changed = this._setModes(this._shuffle, repeatOf(props.LoopStatus)) || changed;

        if (changed)
            this._emit();
        if (trackChanged)
            this._poll();
    }

    // Position is never signalled, so it is asked for outright.
    _readPosition() {
        const proxy = this._proxy;
        proxy?.call('org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (_proxy, res) => {
                try {
                    const [positionUs] = proxy.call_finish(res).recursiveUnpack();
                    if (this._proxy !== proxy)
                        return;
                    this._correct(positionUs);
                    this.emit('position', this._position());
                } catch {
                    // The player went, or the read was cancelled.
                }
            });
    }

    // ------------------------------------------------------------------
    // What am.py says: shuffle, repeat, the catalog id and Apple's cover
    // ------------------------------------------------------------------
    async _poll() {
        if (this._polling || this._destroyed)
            return;
        this._polling = true;
        this._polledAt = GLib.get_monotonic_time();
        try {
            const res = await amctl.run(['now-playing'], {cancellable: this._cancellable});
            if (!this._destroyed)
                this._applyNowPlaying(res);
        } catch {
            // The engine is down, or we are.
        } finally {
            this._polling = false;
        }
    }

    _applyNowPlaying(res) {
        let changed = this._setModes(shuffleOf(res.shuffle), repeatOf(res.repeat));
        const track = res.track;
        if (track && this._track) {
            for (const field of ['id', 'catalogId', 'artUrl']) {
                if (track[field] && this._track[field] !== track[field]) {
                    this._track[field] = track[field];
                    changed = true;
                }
            }
        } else if (track && !this._track && res.state !== 'stopped') {
            // MPRIS said Playing but nothing yet about Metadata (seen right
            // after a track change): filled in from the poll, position too,
            // so the scrubber does not start from wherever it last was.
            const lengthUs = Math.round((Number(track.durationMs) || 0) * 1000);
            this._track = {
                title: track.title ?? '', artist: track.artist ?? '', album: track.album ?? '',
                artUrl: track.artUrl ?? null, lengthUs, catalogId: track.catalogId ?? null,
                id: track.id ?? track.catalogId ?? null, trackId: null,
            };
            this._lengthUs = lengthUs;
            this._correct(Math.round((Number(res.position) || 0) * 1e6));
            changed = true;
        }
        if (changed)
            this._emit();
    }

    _setModes(shuffle, repeat) {
        const changed = shuffle !== this._shuffle || repeat !== this._repeat;
        this._shuffle = shuffle;
        this._repeat = repeat;
        return changed;
    }

    // ------------------------------------------------------------------
    // Position reckoning
    // ------------------------------------------------------------------
    _position() {
        let position = this._positionUs;
        if (this._status === 'Playing')
            position += (GLib.get_monotonic_time() - this._readAtUs) * this._rate;
        position = Math.max(0, position);
        return Math.round(this._lengthUs > 0 ? Math.min(position, this._lengthUs) : position);
    }

    _settle() {
        this._correct(this._position());
    }

    _correct(positionUs) {
        this._positionUs = Math.max(0, Math.round(Number(positionUs) || 0));
        if (this._lengthUs > 0)
            this._positionUs = Math.min(this._positionUs, this._lengthUs);
        this._readAtUs = GLib.get_monotonic_time();
    }

    _startTimer() {
        if (this._timer)
            return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this.emit('position', this._position());
            if (GLib.get_monotonic_time() - this._polledAt >= POLL_INTERVAL_US)
                this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _emit() {
        this.emit('changed');
        this.emit('position', this._position());
    }

    // ------------------------------------------------------------------
    // Transport: MPRIS when a player is attached, am.py otherwise or when
    // MPRIS refuses; shuffle and repeat are am.py's alone.
    // ------------------------------------------------------------------
    playPause() {
        return this._transport('PlayPause', 'toggle');
    }

    next() {
        return this._transport('Next', 'next');
    }

    previous() {
        return this._transport('Previous', 'previous');
    }

    async _transport(method, verb) {
        if (this._proxy) {
            try {
                await this._proxy[`${method}Async`](this._cancellable);
                return;
            } catch {
                // Refused: am.py reaches the engine directly.
            }
        }
        await this._run('control', verb);
    }

    async seek(positionUs) {
        const targetUs = Math.max(0, Math.round(positionUs));
        const offsetUs = targetUs - this._position();
        // Reckoned from here at once, so the scrubber lands where it was let go.
        this._correct(targetUs);
        this._emit();
        const proxy = this._proxy;
        if (proxy) {
            try {
                const trackId = this._track?.trackId;
                if (trackId?.startsWith('/') && trackId !== NO_TRACK)
                    await proxy.SetPositionAsync(trackId, targetUs, this._cancellable);
                else
                    await proxy.SeekAsync(offsetUs, this._cancellable);
                return;
            } catch {
                // Refused, or the track id is no object path: am.py below.
            }
        }
        await this._run('seek', String(Math.round(targetUs / 1e6)));
    }

    async toggleShuffle() {
        const res = await this._run('shuffle', 'toggle');
        if (res && this._setModes(shuffleOf(res.shuffle), repeatOf(res.repeat)))
            this.emit('changed');
    }

    async cycleRepeat() {
        const res = await this._run('repeat', 'cycle');
        if (res && this._setModes(shuffleOf(res.shuffle), repeatOf(res.repeat)))
            this.emit('changed');
    }

    async _run(...args) {
        try {
            return await amctl.run(args, {cancellable: this._cancellable});
        } catch (e) {
            console.warn(`[Music Menu] ${args.join(' ')} failed: ${e.message}`);
            return null;
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancellable.cancel();
        this._stopTimer();
        this._dbus.disconnectSignal(this._ownerId);
        this._proxy?.disconnectObject(this);
        this._proxy?.disconnectSignal(this._seekedId);
        this._proxy = null;
        this._dbus = null;
        this._track = null;
    }
}
