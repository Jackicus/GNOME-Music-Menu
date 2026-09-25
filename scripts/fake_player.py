#!/usr/bin/env python3
"""A pretend MPRIS player for the nested shell, so its player bar and
now-playing view have something to show. The nested session has a bus of
its own, where the real engine's player is never seen; this one says it is
playing a track on music.apple.com and advances the position by itself.

    ./scripts/nested.sh run python3 scripts/fake_player.py [cover.jpg] &

Play/Pause flips the status. Kill it when done; `nested.sh stop` does not."""
import sys, time, warnings
warnings.simplefilter("ignore", DeprecationWarning)
from gi.repository import Gio, GLib

ART = sys.argv[1] if len(sys.argv) > 1 else ''
NODE = Gio.DBusNodeInfo.new_for_xml('''<node>
<interface name="org.mpris.MediaPlayer2">
  <property name="Identity" type="s" access="read"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
</interface>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Next"/><method name="Previous"/><method name="Play"/><method name="Pause"/><method name="Stop"/>
  <method name="Seek"><arg type="x" direction="in"/></method>
  <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
  <signal name="Seeked"><arg type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Rate" type="d" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/><property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/><property name="CanControl" type="b" access="read"/>
</interface></node>''')

state = {'status': 'Playing', 'started': time.monotonic()}
LENGTH_US = 216 * 1000 * 1000

def metadata():
    return GLib.Variant('a{sv}', {
        'mpris:trackid': GLib.Variant('o', '/org/mpris/MediaPlayer2/track/1724040711'),
        'mpris:length': GLib.Variant('x', LENGTH_US),
        'mpris:artUrl': GLib.Variant('s', f'file://{ART}'),
        'xesam:title': GLib.Variant('s', 'Low Tide Warning'),
        'xesam:artist': GLib.Variant('as', ['The Midnight Archipelago']),
        'xesam:album': GLib.Variant('s', 'Signal from the Shallows'),
        'xesam:url': GLib.Variant('s', 'https://music.apple.com/us/album/signal-from-the-shallows/1724040700?i=1724040711'),
    })

def get_prop(conn, sender, path, iface, name):
    if iface == 'org.mpris.MediaPlayer2':
        return {'Identity': GLib.Variant('s', 'Fake Apple Music'), 'CanQuit': GLib.Variant('b', False), 'CanRaise': GLib.Variant('b', False)}[name]
    if name == 'PlaybackStatus': return GLib.Variant('s', state['status'])
    if name == 'Rate': return GLib.Variant('d', 1.0)
    if name == 'Metadata': return metadata()
    if name == 'Position':
        pos = int((time.monotonic() - state['started']) * 1e6) if state['status'] == 'Playing' else 0
        return GLib.Variant('x', min(pos, LENGTH_US))
    return GLib.Variant('b', True)

def method(conn, sender, path, iface, name, params, inv):
    if name == 'PlayPause':
        state['status'] = 'Paused' if state['status'] == 'Playing' else 'Playing'
        conn.emit_signal(None, path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                         GLib.Variant('(sa{sv}as)', ('org.mpris.MediaPlayer2.Player', {'PlaybackStatus': GLib.Variant('s', state['status'])}, [])))
    inv.return_value(None)

def on_bus(conn, name):
    for iface in NODE.interfaces:
        conn.register_object('/org/mpris/MediaPlayer2', iface, method, get_prop, None)
    print('fake player up', flush=True)

Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.fakeapplemusic', Gio.BusNameOwnerFlags.NONE, on_bus, None, lambda *a: sys.exit('name lost'))
GLib.MainLoop().run()
