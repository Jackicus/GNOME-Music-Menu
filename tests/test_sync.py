import json
import os
import shutil
import tempfile
import unittest

from src.backend import sync


class TestSync(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp_dir)

    def test_format_duration(self):
        self.assertEqual(sync.format_duration(0), "0:00")
        self.assertEqual(sync.format_duration(-10), "0:00")
        self.assertEqual(sync.format_duration(45000), "0:45")
        self.assertEqual(sync.format_duration(216000), "3:36")
        self.assertEqual(sync.format_duration(3600000), "1:00:00")
        self.assertEqual(sync.format_duration(3661000), "1:01:01")

    def test_format_count_label(self):
        self.assertEqual(sync.format_count_label(1), "1 song")
        self.assertEqual(sync.format_count_label(10), "10 songs")
        self.assertEqual(sync.format_count_label(12, 43 * 60 * 1000), "12 songs, 43 min")
        self.assertEqual(sync.format_count_label(15, 65 * 60 * 1000), "15 songs, 1 hr 5 min")
        self.assertEqual(sync.format_count_label(20, 120 * 60 * 1000), "20 songs, 2 hr")

    def test_format_color(self):
        self.assertIsNone(sync.format_color(None))
        self.assertIsNone(sync.format_color(""))
        self.assertEqual(sync.format_color("1a1a1a"), "#1a1a1a")
        self.assertEqual(sync.format_color("#1a1a1a"), "#1a1a1a")

    def test_strip_html(self):
        self.assertIsNone(sync.strip_html(None))
        self.assertIsNone(sync.strip_html(""))
        self.assertEqual(sync.strip_html("<p>Hello <b>World</b>&amp;Friends</p>"), "Hello World&Friends")

    def test_artwork_url_and_path(self):
        art_obj = {"url": "https://example.com/art/{w}x{h}bb.{f}", "bgColor": "222222"}
        formatted_url = sync.format_artwork_url(art_obj, 512, 512)
        self.assertEqual(formatted_url, "https://example.com/art/512x512bb.jpg")

        path = sync.get_artwork_cache_path(formatted_url, self.tmp_dir)
        self.assertTrue(path.endswith(".jpg"))
        self.assertTrue(path.startswith(os.path.join(self.tmp_dir, "art")))

    def test_normalize_track(self):
        raw = {
            "id": "1724040711",
            "type": "songs",
            "attributes": {
                "name": "Heroes Get Remembered",
                "artistName": "Four Year Strong",
                "albumName": "Rise or Die Trying",
                "trackNumber": 3,
                "discNumber": 1,
                "durationInMillis": 216000,
                "contentRating": "explicit",
                "playParams": {"catalogId": "1724040711"},
            },
        }
        track = sync.normalize_track(raw, index=2)
        self.assertEqual(track["id"], "1724040711")
        self.assertEqual(track["catalogId"], "1724040711")
        self.assertEqual(track["title"], "Heroes Get Remembered")
        self.assertEqual(track["artist"], "Four Year Strong")
        self.assertEqual(track["album"], "Rise or Die Trying")
        self.assertEqual(track["trackNumber"], 3)
        self.assertEqual(track["discNumber"], 1)
        self.assertEqual(track["durationMs"], 216000)
        self.assertEqual(track["durationLabel"], "3:36")
        self.assertTrue(track["explicit"])
        self.assertEqual(track["index"], 2)

    def test_normalize_album(self):
        raw_album = {
            "id": "l.alb123",
            "type": "library-albums",
            "attributes": {
                "name": "Rise or Die Trying",
                "artistName": "Four Year Strong",
                "releaseDate": "2007-09-18",
                "genreNames": ["Rock"],
                "contentRating": "explicit",
                "trackCount": 2,
                "artwork": {"url": "https://example.com/{w}x{h}.{f}", "bgColor": "112233"},
                "editorialNotes": {"standard": "<p>A classic easycore record.</p>"},
            },
        }
        raw_tracks = [
            {
                "id": "t2",
                "attributes": {
                    "name": "Track Two",
                    "artistName": "Four Year Strong",
                    "trackNumber": 2,
                    "discNumber": 1,
                    "durationInMillis": 180000,
                },
            },
            {
                "id": "t1",
                "attributes": {
                    "name": "Track One",
                    "artistName": "Four Year Strong",
                    "trackNumber": 1,
                    "discNumber": 1,
                    "durationInMillis": 120000,
                },
            },
            {
                "id": "t3",
                "attributes": {
                    "name": "Bonus Track",
                    "artistName": "Four Year Strong",
                    "trackNumber": 1,
                    "discNumber": 2,
                    "durationInMillis": 200000,
                },
            },
        ]

        item = sync.normalize_album(raw_album, cache_dir=self.tmp_dir, tracks=raw_tracks)
        self.assertEqual(item["id"], "l.alb123")
        self.assertEqual(item["kind"], "album")
        self.assertEqual(item["title"], "Rise or Die Trying")
        self.assertEqual(item["subtitle"], "Four Year Strong")
        self.assertEqual(item["year"], 2007)
        self.assertEqual(item["genre"], "Rock")
        self.assertEqual(item["summary"], "A classic easycore record.")
        self.assertEqual(item["artColor"], "#112233")
        self.assertEqual(item["play"], {"kind": "album", "id": "l.alb123"})

        # Two discs
        self.assertEqual(len(item["groups"]), 2)
        disc1 = item["groups"][0]
        self.assertEqual(disc1["name"], "Disc 1")
        self.assertEqual(len(disc1["entries"]), 2)
        # Check sorting by trackNumber
        self.assertEqual(disc1["entries"][0]["title"], "Track One")
        self.assertEqual(disc1["entries"][0]["index"], 0)
        self.assertEqual(disc1["entries"][1]["title"], "Track Two")
        self.assertEqual(disc1["entries"][1]["index"], 1)

        disc2 = item["groups"][1]
        self.assertEqual(disc2["name"], "Disc 2")
        self.assertEqual(len(disc2["entries"]), 1)
        self.assertEqual(disc2["entries"][0]["title"], "Bonus Track")
        self.assertEqual(disc2["entries"][0]["index"], 0)

    def test_normalize_playlist(self):
        raw_playlist = {
            "id": "p.pl123",
            "type": "library-playlists",
            "attributes": {
                "name": "Workout Mix",
                "curatorName": "Jack",
                "lastModifiedDate": "2024-05-01",
                "trackCount": 1,
            },
        }
        raw_tracks = [
            {
                "id": "s1",
                "attributes": {
                    "name": "Energy",
                    "artistName": "Artist",
                    "trackNumber": 1,
                    "durationInMillis": 210000,
                },
            }
        ]

        item = sync.normalize_playlist(raw_playlist, cache_dir=self.tmp_dir, tracks=raw_tracks)
        self.assertEqual(item["id"], "p.pl123")
        self.assertEqual(item["kind"], "playlist")
        self.assertEqual(item["title"], "Workout Mix")
        self.assertEqual(item["subtitle"], "Jack")
        self.assertEqual(item["year"], 2024)
        self.assertEqual(len(item["groups"]), 1)
        self.assertEqual(item["groups"][0]["name"], "Tracks")
        self.assertEqual(item["groups"][0]["entries"][0]["title"], "Energy")

    def test_normalize_station(self):
        raw_station = {
            "id": "ra.12345",
            "type": "stations",
            "attributes": {
                "name": "Apple Music 1",
                "stationProviderName": "Apple Music",
                "description": {"standard": "The new music that matters."},
            },
        }
        item = sync.normalize_station(raw_station, cache_dir=self.tmp_dir)
        self.assertEqual(item["id"], "ra.12345")
        self.assertEqual(item["kind"], "station")
        self.assertEqual(item["title"], "Apple Music 1")
        self.assertEqual(item["subtitle"], "Apple Music")
        self.assertEqual(item["summary"], "The new music that matters.")
        self.assertEqual(item["groups"], [])

    def test_group_songs_into_albums_and_artists(self):
        songs = [
            {
                "id": "s1",
                "attributes": {
                    "name": "Track A",
                    "artistName": "Artist One",
                    "albumName": "Album One",
                    "trackNumber": 1,
                    "discNumber": 1,
                    "durationInMillis": 120000,
                    "releaseDate": "2020-01-01",
                    "genreNames": ["Pop"],
                },
                "relationships": {
                    "albums": {
                        "data": [{
                            "id": "l.alb1",
                            "type": "library-albums",
                            "attributes": {
                                "name": "Album One",
                                "artistName": "Artist One",
                                "releaseDate": "2020-01-01",
                                "genreNames": ["Pop"],
                            },
                        }]
                    }
                },
            },
            {
                "id": "s2",
                "attributes": {
                    "name": "Track B",
                    "artistName": "Artist One",
                    "albumName": "Album One",
                    "trackNumber": 2,
                    "discNumber": 1,
                    "durationInMillis": 180000,
                    "releaseDate": "2020-01-01",
                    "genreNames": ["Pop"],
                },
                "relationships": {
                    "albums": {
                        "data": [{
                            "id": "l.alb1",
                            "type": "library-albums",
                            "attributes": {
                                "name": "Album One",
                                "artistName": "Artist One",
                                "releaseDate": "2020-01-01",
                                "genreNames": ["Pop"],
                            },
                        }]
                    }
                },
            },
        ]

        albums, artists = sync.group_songs_into_albums_and_artists(songs, self.tmp_dir)
        self.assertEqual(len(albums), 1)
        self.assertEqual(albums[0]["title"], "Album One")
        self.assertEqual(len(albums[0]["groups"][0]["entries"]), 2)

        self.assertEqual(len(artists), 1)
        self.assertEqual(artists[0]["title"], "Artist One")
        self.assertEqual(len(artists[0]["groups"]), 1)
        self.assertEqual(artists[0]["groups"][0]["name"], "Album One")

    def test_save_library_and_merge(self):
        initial = {
            "version": 1,
            "generated": "2026-09-25T12:00:00Z",
            "storefront": "us",
            "sections": {
                "albums": [{"id": "a1", "title": "Album 1"}],
                "artists": [{"id": "art1", "title": "Artist 1"}],
                "playlists": [{"id": "p1", "title": "Playlist 1"}],
                "radio": [{"id": "r1", "title": "Radio 1"}],
            },
            "shelves": [{"key": "heavy-rotation", "title": "Heavy Rotation", "items": []}],
        }
        sync.save_library(initial, self.tmp_dir)

        lib_file = os.path.join(self.tmp_dir, "library.json")
        self.assertTrue(os.path.exists(lib_file))
        with open(lib_file, "r") as f:
            data = json.load(f)
        self.assertEqual(len(data["sections"]["albums"]), 1)

        # Merge with only albums updated
        updated = {
            "version": 1,
            "generated": "2026-09-25T13:00:00Z",
            "storefront": "us",
            "sections": {
                "albums": [
                    {"id": "a1", "title": "Album 1"},
                    {"id": "a2", "title": "Album 2"},
                ],
                "artists": [],
                "playlists": [],
                "radio": [],
            },
            "shelves": [],
        }
        sync.save_library(updated, self.tmp_dir, only="albums")

        with open(lib_file, "r") as f:
            merged = json.load(f)

        self.assertEqual(len(merged["sections"]["albums"]), 2)
        # playlists still preserved
        self.assertEqual(len(merged["sections"]["playlists"]), 1)
        self.assertEqual(len(merged["shelves"]), 1)

    def test_prune_art(self):
        art_dir = os.path.join(self.tmp_dir, "art")
        os.makedirs(art_dir, exist_ok=True)
        used_file = os.path.join(art_dir, "used.jpg")
        unused_file = os.path.join(art_dir, "unused.jpg")

        with open(used_file, "w") as f:
            f.write("test")
        with open(unused_file, "w") as f:
            f.write("test")

        lib_data = {
            "sections": {
                "albums": [{"art": used_file}],
                "artists": [],
                "playlists": [],
                "radio": [],
            },
            "shelves": [],
        }

        sync.prune_art(lib_data, self.tmp_dir)
        self.assertTrue(os.path.exists(used_file))
        self.assertFalse(os.path.exists(unused_file))


if __name__ == "__main__":
    unittest.main()


class TestArtworkDownload(unittest.TestCase):
    """Normalisation names the file; download_art fetches what is missing."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        sync.ART_URLS.clear()

    def tearDown(self):
        shutil.rmtree(self.tmp_dir)
        sync.ART_URLS.clear()

    def _album(self, art_url):
        return {
            "id": "l.one", "type": "library-albums",
            "attributes": {"name": "One", "artistName": "A", "artwork": {"url": art_url}},
        }

    def test_extract_registers_url_for_path(self):
        item = sync.normalize_album(self._album("https://x/{w}x{h}bb.jpg"), cache_dir=self.tmp_dir)
        self.assertTrue(item["art"].startswith(os.path.join(self.tmp_dir, "art")))
        self.assertEqual(sync.ART_URLS[item["art"]], "https://x/512x512bb.jpg")

    def test_download_art_fetches_only_missing(self):
        item = sync.normalize_album(self._album("https://x/{w}x{h}bb.jpg"), cache_dir=self.tmp_dir)
        other = sync.normalize_album(dict(self._album("https://y/{w}x{h}bb.jpg"), id="l.two"), cache_dir=self.tmp_dir)
        os.makedirs(os.path.dirname(other["art"]), exist_ok=True)
        with open(other["art"], "wb") as f:
            f.write(b"already here")
        lib = {"sections": {"albums": [item, other]}, "shelves": []}

        fetched = []

        def fake_cache(url, cache_dir):
            fetched.append(url)
            path = sync.artwork_cache_path(url, cache_dir)
            with open(path, "wb") as f:
                f.write(b"img")
            return path

        real = sync.cache_artwork
        sync.cache_artwork = fake_cache
        try:
            counts = sync.download_art(lib, self.tmp_dir, log=lambda m: None)
        finally:
            sync.cache_artwork = real
        self.assertEqual(fetched, ["https://x/512x512bb.jpg"])
        self.assertEqual(counts, {"wanted": 2, "fetched": 1, "failed": 0})
        self.assertTrue(os.path.exists(item["art"]))

    def test_download_art_counts_failures(self):
        item = sync.normalize_album(self._album("https://x/{w}x{h}bb.jpg"), cache_dir=self.tmp_dir)
        lib = {"sections": {"albums": [item]}, "shelves": []}
        logged = []
        real = sync.cache_artwork
        sync.cache_artwork = lambda url, cache_dir: None
        try:
            counts = sync.download_art(lib, self.tmp_dir, log=logged.append)
        finally:
            sync.cache_artwork = real
        self.assertEqual(counts["failed"], 1)
        self.assertEqual(len(logged), 1)

    def test_album_stub_without_attributes_takes_song_name(self):
        songs = [{
            "id": "i.1", "type": "library-songs",
            "attributes": {
                "name": "Pa", "albumName": "Love Collection", "artistName": "Kana",
                "trackNumber": 1, "discNumber": 1, "durationInMillis": 1000,
                "artwork": {"url": "https://x/{w}x{h}bb.jpg"},
            },
            "relationships": {"albums": {"data": [{"id": "l.gone", "type": "library-albums"}]}},
        }]
        albums, artists = sync.group_songs_into_albums_and_artists(songs, self.tmp_dir)
        self.assertEqual(albums[0]["id"], "l.gone")
        self.assertEqual(albums[0]["title"], "Love Collection")
        self.assertEqual(albums[0]["subtitle"], "Kana")
        self.assertIsNotNone(albums[0]["art"])
        self.assertEqual(artists[0]["title"], "Kana")
