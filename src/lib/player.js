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
// MPRIS is believed about play, pause and which track, and used for the
// transport. It is not believed about time. Chrome reports the position and
// length of its media element, and Apple's gapless player runs one element
// across track after track, so a three-minute song arrives as the eighth
// minute of a thirteen-minute one. The track's own position and length come
// from am.py's `now-playing` — MusicKit's reckoning — asked once per track
// change, once per play or pause, once per `Seeked` the engine sends on its
// own, and every half minute while playing to check the clock; between
// answers the position runs off the monotonic clock. Shuffle, repeat, the
// catalog id and Apple's own cover art ride along with each answer. Only
// when the engine does not answer — the player is somebody else's, or it is
// down — do the player's own numbers stand in. The poll never starts an
// engine: a player on the bus means one is running.

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
const POLL_INTERVAL_US = 30 * 1000 * 1000;
// The reckoned position is left alone unless the engine's answer is this
// far out: MusicKit counts whole seconds, and the answer is a spawn and a
// round trip old.
const DRIFT_US = 2 * 1000 * 1000;
// An answer asked for this soon after our own seek may predate it.
const SEEK_GRACE_US = 2 * 1000 * 1000;

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
        this._pollAgain = false;
        this._polledAt = 0;
        this._seekAt = 0;
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
                lengthUs: this._lengthUs, catalogId: track.catalogId, id: track.id,
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
        this._seekedId = proxy.connectSignal('Seeked', (_proxy, _sender, [positionUs]) => this._onSeeked(positionUs));
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
        // Where the length and position come from: null while the engine
        // is being asked about the track, 'engine' once it has answered,
        // 'mpris' when it did not and the player's own numbers stand in.
        this._source = null;
        this._lengthUs = 0;
        this._mprisLengthUs = 0;
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
            // Not the length: Chrome's grows mid-track as the next one is
            // buffered behind this one.
            const key = t => t && [t.title, t.artist, t.album, t.trackId].join('\n');
            this._mprisLengthUs = parsed?.lengthUs ?? 0;
            if (key(parsed) !== key(this._track)) {
                trackChanged = changed = true;
                this._track = parsed && {
                    ...parsed,
                    // Headless Chrome's media-session art is its own logo, not
                    // the cover; the poll brings Apple's.
                    artUrl: /\/\.com\.google\.Chrome\./.test(parsed.artUrl ?? '') ? null : parsed.artUrl,
                    id: parsed.catalogId ?? parsed.trackId ?? null,
                };
                // The length waits for the engine's answer rather than
                // showing Chrome's for the moment it takes.
                this._source = null;
                this._lengthUs = 0;
                this._correct(0);
            } else if (this._source === 'mpris' && this._lengthUs !== this._mprisLengthUs) {
                this._lengthUs = this._mprisLengthUs;
                changed = true;
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

        if ('Shuffle' in props)
            changed = this._setModes(shuffleOf(props.Shuffle), this._repeat) || changed;
        if ('LoopStatus' in props)
            changed = this._setModes(this._shuffle, repeatOf(props.LoopStatus)) || changed;

        if (changed)
            this._emit();

        // Position is never signalled; a new track or a play or pause is
        // the moment to ask for it.
        if (trackChanged)
            this._poll();
        else if (statusChanged && this._status !== 'Stopped')
            this._refreshPosition();
    }

    // The engine's `Seeked` carries its element's time, not the track's: it
    // says only that something moved, so the engine is asked — unless the
    // move was ours, which the seek already accounted for.
    _onSeeked(positionUs) {
        if (this._source === 'mpris') {
            this._correct(positionUs);
            this._emit();
        } else if (GLib.get_monotonic_time() >= this._seekAt + SEEK_GRACE_US) {
            this._poll();
        }
    }

    _refreshPosition() {
        if (this._source === 'mpris')
            this._readPosition();
        else
            this._poll();
    }

    // Another player's Position, asked for outright.
    _readPosition() {
        const proxy = this._proxy;
        proxy?.call('org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (_proxy, res) => {
                try {
                    const [positionUs] = proxy.call_finish(res).recursiveUnpack();
                    if (this._proxy !== proxy || this._source !== 'mpris')
                        return;
                    this._correct(positionUs);
                    this.emit('position', this._position());
                } catch {
                    // The player went, or the read was cancelled.
                }
            });
    }

    // ------------------------------------------------------------------
    // What am.py says: the track's length and position, shuffle, repeat,
    // the catalog id and Apple's cover
    // ------------------------------------------------------------------
    async _poll() {
        if (this._destroyed)
            return;
        // One at a time; a request during a poll means one more after it,
        // since the answer under way may predate what prompted the request.
        if (this._polling) {
            this._pollAgain = true;
            return;
        }
        this._polling = true;
        do {
            this._pollAgain = false;
            const askedAt = this._polledAt = GLib.get_monotonic_time();
            try {
                const res = await amctl.run(['--no-start', 'now-playing'], {cancellable: this._cancellable});
                if (!this._destroyed)
                    this._applyNowPlaying(res, askedAt);
            } catch {
                // The engine is down, or this player is not its: its own
                // numbers will have to do.
                if (!this._destroyed && this._source === null)
                    this._adoptMpris();
            }
        } while (this._pollAgain && !this._destroyed);
        this._polling = false;
    }

    _applyNowPlaying(res, askedAt) {
        let changed = this._setModes(shuffleOf(res.shuffle), repeatOf(res.repeat));
        // Answered after the player left the bus: nothing to fill in.
        const track = this._proxy ? res.track : null;
        if (track && !this._track && res.state !== 'stopped') {
            // MPRIS said Playing but nothing yet about Metadata (seen right
            // after a track change): the answer fills the track in.
            this._track = {
                title: track.title ?? '', artist: track.artist ?? '', album: track.album ?? '',
                artUrl: track.artUrl ?? null, catalogId: track.catalogId ?? null,
                id: track.id ?? track.catalogId ?? null, trackId: null,
            };
            changed = true;
        }
        if (track && this._track) {
            for (const field of ['id', 'catalogId', 'artUrl']) {
                if (track[field] && this._track[field] !== track[field]) {
                    this._track[field] = track[field];
                    changed = true;
                }
            }
            const lengthUs = track.durationMs > 0
                ? Math.round(track.durationMs * 1000)
                : Math.round((Number(res.duration) || 0) * 1e6);
            if (lengthUs > 0 && lengthUs !== this._lengthUs) {
                this._lengthUs = lengthUs;
                changed = true;
            }
            // The first answer for a track is taken as it is; later ones
            // only when the clock has drifted from it. An answer asked for
            // around our own seek is not, whichever side of it it fell.
            let positionUs = Math.round((Number(res.position) || 0) * 1e6);
            if (res.state === 'playing')
                positionUs += (GLib.get_monotonic_time() - askedAt) * this._rate;
            const nearOurSeek = askedAt < this._seekAt + SEEK_GRACE_US;
            if (!nearOurSeek && (this._source !== 'engine' || Math.abs(positionUs - this._position()) > DRIFT_US)) {
                this._correct(positionUs);
                changed = true;
            }
            this._source = 'engine';
        }
        if (changed)
            this._emit();
    }

    _adoptMpris() {
        this._source = 'mpris';
        if (this._lengthUs !== this._mprisLengthUs) {
            this._lengthUs = this._mprisLengthUs;
            this._emit();
        }
        this._readPosition();
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
    // MPRIS refuses. Seeks go to MusicKit, which counts in the track's own
    // time; shuffle and repeat are am.py's alone.
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
        this._seekAt = GLib.get_monotonic_time();
        this._correct(targetUs);
        this._emit();
        // Only another player is seeked over MPRIS: the engine's SetPosition
        // would move Chrome's element, whose time is not the track's.
        const proxy = this._proxy;
        if (proxy && this._source === 'mpris') {
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
        await this._run('seek', (targetUs / 1e6).toFixed(3));
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
