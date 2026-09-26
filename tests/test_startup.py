"""am.py starts light: every command is a process of its own, and the
player's poll, a search and a volume set all pay for whatever is imported
at load. PyGObject, urllib and the thread pool are only for a sync's
artwork, and the process modules only for starting Chrome."""

import os
import subprocess
import sys
import unittest

BACKEND = os.path.join(os.path.dirname(__file__), "..", "src", "backend")
HEAVY = ("gi", "urllib.request", "http.client", "concurrent.futures", "ssl", "subprocess", "tempfile", "fcntl")


class Startup(unittest.TestCase):
    def test_nothing_heavy_is_imported_at_load(self):
        code = (
            "import sys; sys.path.insert(0, sys.argv[1]); import am; "
            f"print(sorted(m for m in {HEAVY!r} if m in sys.modules))"
        )
        out = subprocess.run([sys.executable, "-c", code, BACKEND], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), "[]")
