"""am.py's argument parsing: every command reaches its handler with the
right arguments, and a bad command line is an AmError('usage'), never
argparse's own stderr-and-exit-2."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "backend"))

import am  # noqa: E402


def parse(argv):
    """Run run_cli with every handler replaced; return (handler name, args, kwargs)."""
    calls = []
    names = [n for n in dir(am) if n.startswith("handle_") or n.startswith("engine_")]
    patches = [mock.patch.object(am, n, (lambda n: lambda *a, **k: calls.append((n, a, k)) or {"ok": True})(n))
               for n in names]
    for p in patches:
        p.start()
    try:
        am.run_cli(argv)
    finally:
        for p in patches:
            p.stop()
    return calls[-1]


class Cli(unittest.TestCase):
    def test_engine(self):
        self.assertEqual(parse(["engine", "start"]), ("engine_start", (), {"headless": None}))
        self.assertEqual(parse(["engine", "start", "--visible"]), ("engine_start", (), {"headless": False}))
        self.assertEqual(parse(["engine", "start", "--headless"]), ("engine_start", (), {"headless": True}))
        self.assertEqual(parse(["engine", "stop"])[0], "engine_stop")
        self.assertEqual(parse(["engine", "status"])[0], "engine_status")

    def test_status_never_starts(self):
        self.assertEqual(parse(["status"]), ("handle_status", (), {}))

    def test_no_start_anywhere(self):
        self.assertEqual(parse(["sync"]), ("handle_sync", (), {"only": None, "no_start": False}))
        self.assertEqual(parse(["sync", "--no-start"]), ("handle_sync", (), {"only": None, "no_start": True}))
        self.assertEqual(parse(["--no-start", "sync"]), ("handle_sync", (), {"only": None, "no_start": True}))
        self.assertEqual(parse(["--no-start", "sync", "--only", "radio"]),
                         ("handle_sync", (), {"only": "radio", "no_start": True}))

    def test_play(self):
        self.assertEqual(parse(["play", "album", "l.abc"]),
                         ("handle_play", ("album", "l.abc"), {"start_with": 0, "shuffle": False, "no_start": False}))
        self.assertEqual(parse(["play", "album", "l.abc", "--start-with", "3", "--shuffle"]),
                         ("handle_play", ("album", "l.abc"), {"start_with": 3, "shuffle": True, "no_start": False}))
        self.assertEqual(parse(["play-next", "song", "123"]), ("handle_play_next", ("song", "123"), {"no_start": False}))
        self.assertEqual(parse(["play-later", "song", "123"]), ("handle_play_later", ("song", "123"), {"no_start": False}))

    def test_transport(self):
        self.assertEqual(parse(["control", "toggle"]), ("handle_control", ("toggle",), {"no_start": False}))
        self.assertEqual(parse(["seek", "42"]), ("handle_seek", ("42",), {"no_start": False}))
        self.assertEqual(parse(["volume", "0.5"]), ("handle_volume", ("0.5",), {"no_start": False}))
        self.assertEqual(parse(["shuffle", "toggle"]), ("handle_shuffle", ("toggle",), {"no_start": False}))
        self.assertEqual(parse(["repeat", "cycle"]), ("handle_repeat", ("cycle",), {"no_start": False}))
        self.assertEqual(parse(["now-playing"]), ("handle_now_playing", (), {"no_start": False}))
        self.assertEqual(parse(["queue"]), ("handle_queue", (), {"no_start": False}))

    def test_library_actions(self):
        self.assertEqual(parse(["love", "song", "1"]), ("handle_love", ("song", "1"), {"love": True, "no_start": False}))
        self.assertEqual(parse(["unlove", "song", "1"]), ("handle_love", ("song", "1"), {"love": False, "no_start": False}))
        self.assertEqual(parse(["add-to-library", "album", "1"]), ("handle_add_to_library", ("album", "1"), {"no_start": False}))
        self.assertEqual(parse(["playlists"]), ("handle_playlists", (), {"no_start": False}))
        self.assertEqual(parse(["add-to-playlist", "p.1", "i.2"]), ("handle_add_to_playlist", ("p.1", "i.2"), {"no_start": False}))
        self.assertEqual(parse(["lyrics", "999"]), ("handle_lyrics", ("999",), {"no_start": False}))
        self.assertEqual(parse(["item", "album", "1"]), ("handle_item", ("album", "1"), {"no_start": False}))
        self.assertEqual(parse(["signin"])[0], "handle_signin")

    def test_search(self):
        self.assertEqual(parse(["search", "a", "b", "--limit", "5"]),
                         ("handle_search", ("a b",), {"library": False, "limit": 5, "no_start": False}))
        self.assertEqual(parse(["search", "daft punk", "--library"]),
                         ("handle_search", ("daft punk",), {"library": True, "limit": 20, "no_start": False}))

    def test_suggest(self):
        self.assertEqual(parse(["suggest", "sho", "--limit", "5", "--no-start"]),
                         ("handle_suggest", ("sho",), {"limit": 5, "no_start": True}))
        self.assertEqual(parse(["suggest", "shout", "out"]),
                         ("handle_suggest", ("shout out",), {"limit": 10, "no_start": False}))

    def test_landing_and_category(self):
        self.assertEqual(parse(["landing", "--no-start"]), ("handle_landing", (), {"no_start": True}))
        self.assertEqual(parse(["category", "988581516"]), ("handle_category", ("988581516",), {"no_start": False}))

    def test_usage_errors(self):
        for argv in ([], ["bogus"], ["engine"], ["engine", "dance"], ["play", "album"],
                     ["play", "album", "1", "--start-with", "x"], ["sync", "--only", "films"],
                     ["search"], ["search", "--limit", "n", "x"], ["lyrics"], ["--help"], ["play", "-h"]):
            with self.subTest(argv=argv):
                with self.assertRaises(am.AmError) as cm:
                    am.run_cli(argv)
                self.assertEqual(cm.exception.code, "usage")
