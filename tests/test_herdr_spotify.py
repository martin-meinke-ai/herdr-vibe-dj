from __future__ import annotations

import base64
import hashlib
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

from importlib.machinery import SourceFileLoader

BIN_PATH = Path(__file__).resolve().parent.parent / "bin/herdr-spotify"
loader = SourceFileLoader("herdr_spotify_standalone", str(BIN_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None and spec.loader is not None
spotify = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = spotify
spec.loader.exec_module(spotify)


class SpotifyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = mock.patch.multiple(
            spotify,
            SPOTIFY_DIR=Path("/tmp/test_herdr_spotify"),
            CONFIG_PATH=Path("/tmp/test_herdr_spotify/config.json"),
            TOKENS_PATH=Path("/tmp/test_herdr_spotify/tokens.json"),
            AUTH_STATE_PATH=Path("/tmp/test_herdr_spotify/auth_state.json"),
            AUTH_LOG_PATH=Path("/tmp/test_herdr_spotify/auth_worker.log"),
            CACHE_PATH=Path("/tmp/test_herdr_spotify/playback_cache.json"),
            REFRESH_LOCK_PATH=Path("/tmp/test_herdr_spotify/refresh.lock"),
            VIBE_DJ_STATE_PATH=Path("/tmp/test_herdr_spotify/vibe_dj.json"),
            VIBE_DJ_LOCK_PATH=Path("/tmp/test_herdr_spotify/vibe_dj.lock"),
        )
        self._tmp.start()
        for p in Path("/tmp/test_herdr_spotify").glob("*"):
            if p.is_file():
                p.unlink()

    def tearDown(self) -> None:
        self._tmp.stop()

    def test_pkce_pair_and_authorize_url(self) -> None:
        verifier, challenge = spotify.make_pkce_pair()
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
        self.assertEqual(challenge, expected)
        url = spotify.build_authorize_url("abcdef1234567890abcdef1234567890", spotify.DEFAULT_REDIRECT_URI, "st123", challenge)
        self.assertIn("code_challenge_method=S256", url)
        self.assertIn("127.0.0.1%3A18472%2Fcallback", url)
        self.assertIn("user-modify-playback-state", url)
        self.assertIn("playlist-read-private", url)

    def test_set_client_id_validation(self) -> None:
        with self.assertRaises(ValueError):
            spotify.set_client_id("too short!")
        res = spotify.set_client_id("0123456789abcdef0123456789abcdef")
        self.assertTrue(res["configured"])
        cfg = spotify.load_config()
        self.assertEqual(cfg["client_id"], "0123456789abcdef0123456789abcdef")

    def test_complete_auth_from_callback_url(self) -> None:
        spotify.set_client_id("0123456789abcdef0123456789abcdef")
        spotify._write_secret_json(
            spotify.AUTH_STATE_PATH,
            {
                "status": "pending",
                "state": "expected_state",
                "code_verifier": "verifier_abc",
                "redirect_uri": spotify.DEFAULT_REDIRECT_URI,
            },
        )
        with self.assertRaises(RuntimeError):
            spotify.complete_auth_from_input("http://127.0.0.1:18472/callback?code=xyz&state=wrong_state")

        fake_tok = {"access_token": "tok_123", "refresh_token": "ref_456", "expires_in": 3600}
        with mock.patch.object(spotify, "_token_request", return_value=fake_tok):
            out = spotify.complete_auth_from_input("http://127.0.0.1:18472/callback?code=xyz&state=expected_state")
        self.assertTrue(out["authenticated"])
        saved = spotify.load_tokens()
        self.assertIsNotNone(saved)
        assert saved is not None
        self.assertEqual(saved["access_token"], "tok_123")
        self.assertEqual(saved["refresh_token"], "ref_456")

    def test_normalize_playback_active_and_idle(self) -> None:
        spotify.set_client_id("0123456789abcdef0123456789abcdef")
        idle = spotify._normalize_playback(None)
        self.assertFalse(idle["active"])

        raw = {
            "is_playing": True,
            "progress_ms": 42000,
            "shuffle_state": True,
            "repeat_state": "context",
            "device": {"id": "dev1", "name": "MacBook Pro", "type": "Computer", "volume_percent": 72},
            "item": {
                "id": "trk1",
                "name": "Propuesta Indecente",
                "duration_ms": 235000,
                "artists": [{"name": "Romeo Santos"}],
                "album": {
                    "name": "Formula, Vol. 2",
                    "images": [
                        {"width": 640, "url": "https://img/640.jpg"},
                        {"width": 300, "url": "https://img/300.jpg"},
                    ],
                },
                "external_urls": {"spotify": "https://open.spotify.com/track/trk1"},
            },
        }
        norm = spotify._normalize_playback(raw, is_liked=True)
        self.assertTrue(norm["active"])
        self.assertEqual(norm["track"], "Propuesta Indecente")
        self.assertEqual(norm["artists"], "Romeo Santos")
        self.assertEqual(norm["artwork_url"], "https://img/300.jpg")
        self.assertTrue(norm["is_liked"])
        self.assertEqual(norm["volume_percent"], 72)

    def test_vibe_tiers_and_suggestions(self) -> None:
        self.assertEqual(spotify.compute_vibe_tier(0), "zen")
        self.assertEqual(spotify.compute_vibe_tier(1), "zen")
        self.assertEqual(spotify.compute_vibe_tier(2), "flow")
        self.assertEqual(spotify.compute_vibe_tier(3), "flow")
        self.assertEqual(spotify.compute_vibe_tier(4), "cranking")
        self.assertEqual(spotify.compute_vibe_tier(5), "cranking")
        self.assertEqual(spotify.compute_vibe_tier(6), "overdrive")

        fake_search = {
            "tracks": {
                "items": [
                    {
                        "id": "t1",
                        "uri": "spotify:track:t1",
                        "name": "Midnight Bachata",
                        "duration_ms": 210000,
                        "artists": [{"name": "Artist A"}],
                        "album": {"name": "Album A"},
                        "external_urls": {"spotify": "https://open.spotify.com/track/t1"},
                    }
                ]
            }
        }
        with mock.patch.object(spotify, "_api_request", return_value=(200, fake_search)):
            res = spotify.suggest_tracks(intensity="cranking", vibe="bachata", offset=0, limit=5)
        self.assertEqual(res["tier"], "cranking")
        self.assertEqual(res["vibe"], "bachata")
        self.assertEqual(len(res["tracks"]), 1)
        self.assertEqual(res["tracks"][0]["uri"], "spotify:track:t1")


    def test_vibe_dj_disabled_is_noop(self) -> None:
        with mock.patch.object(spotify, "get_status") as m_status, mock.patch.object(spotify, "queue_uri") as m_queue:
            res = spotify.tick_vibe_dj(working_agents=4, force=True)
        self.assertFalse(res["enabled"])
        self.assertEqual(res["tier"], "cranking")
        self.assertEqual(res["last_action"], "off")
        m_status.assert_not_called()
        m_queue.assert_not_called()

    def test_vibe_dj_paused_does_not_queue(self) -> None:
        paused = {"authenticated": True, "active": True, "is_playing": False}
        with mock.patch.object(spotify, "get_status", return_value=paused), mock.patch.object(spotify, "queue_uri") as m_queue:
            res = spotify.set_vibe_dj(enabled=True, working_agents=2)
        self.assertTrue(res["enabled"])
        self.assertEqual(res["last_action"], "paused")
        self.assertEqual(res["queued_ahead_count"], 0)
        m_queue.assert_not_called()

    def test_vibe_dj_just_in_time_single_track(self) -> None:
        state_play = {
            "authenticated": True,
            "active": True,
            "is_playing": True,
            "track_id": "cur0",
            "duration_ms": 200_000,
            "progress_ms": 40_000,  # 160s left -> should wait, not queue
        }
        queued_uris: list[str] = []

        def fake_queue():
            return {
                "currently_playing_uri": f"spotify:track:{state_play['track_id']}",
                "queue": [{"uri": u, "track": u, "artists": "A", "duration_ms": 180000} for u in queued_uris],
            }

        def fake_suggest(intensity="flow", vibe=None, offset=0, limit=5, **_kwargs):
            tracks = [
                {
                    "id": f"{intensity}_{i}",
                    "uri": f"spotify:track:{intensity}_{i}",
                    "track": f"{intensity} Track {i}",
                    "artists": "DJ Bot",
                    "album": "Mix",
                    "duration_ms": 200000,
                    "track_url": None,
                }
                for i in range(1, 5)
            ]
            return {
                "tier": intensity,
                "label": intensity,
                "subtitle": "",
                "vibe": vibe or "electronic",
                "available_vibes": ["electronic", "bachata"],
                "query": "q",
                "tracks": tracks,
            }

        def fake_queue_uri(uri: str):
            queued_uris.append(uri)
            return {"ok": True, "queued": uri}

        clock = [1000.0]

        def advance(dt: float = 15.0) -> None:
            clock[0] += dt

        with (
            mock.patch.object(spotify.time, "time", side_effect=lambda: clock[0]),
            mock.patch.object(spotify, "get_status", side_effect=lambda **_k: dict(state_play)),
            mock.patch.object(spotify, "get_queue", side_effect=fake_queue),
            mock.patch.object(spotify, "suggest_tracks", side_effect=fake_suggest),
            mock.patch.object(spotify, "queue_uri", side_effect=fake_queue_uri),
        ):
            # Enable with 160s left -> waits (queues 0 tracks)
            r1 = spotify.set_vibe_dj(enabled=True, working_agents=2)
            self.assertTrue(r1["enabled"])
            self.assertEqual(r1["last_action"], "waiting")
            self.assertEqual(r1["next_queue_in_s"], 100)
            self.assertEqual(len(queued_uris), 0)

            advance(15.0)
            # Advance to 45s left (<= 60s) with 6 agents -> queues 1 overdrive track
            state_play["progress_ms"] = 155_000
            r2 = spotify.tick_vibe_dj(working_agents=6, force=False)
            self.assertEqual(r2["tier"], "overdrive")
            self.assertEqual(len(r2["added"]), 1)
            self.assertEqual(r2["added"][0]["uri"], "spotify:track:overdrive_1")
            self.assertEqual(len(queued_uris), 1)

            advance(15.0)
            # Another tick on same song -> steady, does NOT queue again
            r3 = spotify.tick_vibe_dj(working_agents=6, force=False)
            self.assertEqual(len(r3["added"]), 0)
            self.assertEqual(len(queued_uris), 1)

            advance(15.0)
            # Song advances to overdrive_1, near end (30s left) with 0 agents -> queues 1 zen track
            state_play["track_id"] = "overdrive_1"
            state_play["progress_ms"] = 170_000
            r4 = spotify.tick_vibe_dj(working_agents=0, force=False)
            self.assertEqual(r4["tier"], "zen")
            self.assertEqual(len(r4["added"]), 1)
            self.assertEqual(r4["added"][0]["uri"], "spotify:track:zen_1")

            # Disable
            r5 = spotify.set_vibe_dj(enabled=False, working_agents=0)
            self.assertFalse(r5["enabled"])
            self.assertEqual(r5["last_action"], "off")

    def test_vibe_dj_inverse_mode(self) -> None:
        self.assertEqual(spotify.compute_vibe_tier(0, inverse=True), "overdrive")
        self.assertEqual(spotify.compute_vibe_tier(1, inverse=True), "overdrive")
        self.assertEqual(spotify.compute_vibe_tier(2, inverse=True), "cranking")
        self.assertEqual(spotify.compute_vibe_tier(4, inverse=True), "flow")
        self.assertEqual(spotify.compute_vibe_tier(6, inverse=True), "zen")

        res = spotify.set_vibe_dj(inverse=True, working_agents=6, sync_now=False)
        self.assertTrue(res["inverse"])
        self.assertEqual(res["auto_tier"], "zen")
        self.assertEqual(res["tier"], "zen")

        res_idle = spotify.get_vibe_dj_status(working_agents=0)
        self.assertTrue(res_idle["inverse"])
        self.assertEqual(res_idle["auto_tier"], "overdrive")
        self.assertEqual(res_idle["tier"], "overdrive")


    def test_vibe_dj_custom_preferences(self) -> None:
        res = spotify.set_vibe_dj(
            taste="french house, khruangbin",
            tier_queries={"zen": "bill evans piano, nils frahm"},
            working_agents=0,
            sync_now=False,
        )
        self.assertEqual(res["taste"], "french house, khruangbin")
        self.assertEqual(res["custom_queries"], {"zen": "bill evans piano, nils frahm"})
        self.assertTrue(res["has_custom"])
        self.assertEqual(res["vibe"], "custom")

        # Zen uses explicit per-tier override verbatim
        fake_search = {"tracks": {"items": []}}
        with mock.patch.object(spotify, "_api_request", return_value=(200, fake_search)) as m_api:
            s_zen = spotify.suggest_tracks(intensity="zen", vibe="custom", offset=0, limit=5)
        self.assertEqual(s_zen["vibe"], "custom")
        self.assertEqual(s_zen["query"], "bill evans piano")
        self.assertIn("custom", s_zen["available_vibes"])
        self.assertEqual(m_api.call_args.kwargs["params"]["q"], "bill evans piano")

        # Cranking falls back to global taste blended with cranking energy modifier
        with mock.patch.object(spotify, "_api_request", return_value=(200, fake_search)):
            s_crank = spotify.suggest_tracks(intensity="cranking", vibe="custom", offset=1, limit=5)
        self.assertEqual(s_crank["vibe"], "custom")
        self.assertEqual(s_crank["query"], "khruangbin upbeat driving")

        # Clearing resets custom vibe cleanly
        cleared = spotify.set_vibe_dj(taste="", tier_queries={"zen": ""}, working_agents=0, sync_now=False)
        self.assertFalse(cleared["has_custom"])
        self.assertNotEqual(cleared["vibe"], "custom")


    def test_api_request_tolerates_non_json_mutation_200(self) -> None:
        class FakeResp:
            status = 200

            def __init__(self, body: bytes) -> None:
                self._body = body

            def read(self) -> bytes:
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with (
            mock.patch.object(spotify, "_get_valid_access_token", return_value="tok"),
            mock.patch.object(spotify.urllib.request, "urlopen", return_value=FakeResp(b"12345 extra data")),
        ):
            code, payload = spotify._api_request("PUT", "/me/player/play")
        self.assertEqual(code, 200)
        self.assertIsNone(payload)


    def test_like_uses_me_library_endpoint(self) -> None:
        with (
            mock.patch.object(spotify, "_api_request", return_value=(200, None)) as m_api,
            mock.patch.object(spotify, "get_status", return_value={"ok": True}),
        ):
            spotify.control_playback("like", value="on", track_id="abc123")
        m_api.assert_called_once_with("PUT", "/me/library", params={"uris": "spotify:track:abc123"})

    def test_vibe_dj_does_not_requeue_same_track_when_queue_truncated_at_20(self) -> None:
        playing = {
            "authenticated": True,
            "active": True,
            "is_playing": True,
            "track_id": "cur0",
            "duration_ms": 200_000,
            "progress_ms": 160_000,  # 40s left
        }
        long_queue = {
            "currently_playing_uri": "spotify:track:cur0",
            "queue": [{"uri": f"spotify:track:other_{i}", "track": f"O{i}", "artists": "X", "duration_ms": 180000} for i in range(20)],
        }
        fake_suggest = {
            "tier": "flow",
            "label": "Flow",
            "subtitle": "",
            "vibe": "chill-elec",
            "available_vibes": ["chill-elec"],
            "query": "q",
            "tracks": [
                {"id": f"f{i}", "uri": f"spotify:track:f{i}", "track": f"F{i}", "artists": "A", "album": "B", "duration_ms": 200000, "track_url": None}
                for i in range(1, 5)
            ],
        }
        queued_calls: list[str] = []
        with (
            mock.patch.object(spotify, "get_status", return_value=playing),
            mock.patch.object(spotify, "get_queue", return_value=long_queue),
            mock.patch.object(spotify, "suggest_tracks", return_value=fake_suggest),
            mock.patch.object(spotify, "queue_uri", side_effect=lambda u: queued_calls.append(u) or {"ok": True}),
        ):
            r1 = spotify.set_vibe_dj(enabled=True, working_agents=2)
            self.assertEqual(len(r1["added"]), 1)
            # Second tick while same track is playing -> MUST NOT re-queue
            r2 = spotify.tick_vibe_dj(working_agents=2, force=False)
            self.assertEqual(len(r2["added"]), 0)
            self.assertEqual(len(queued_calls), 1)


if __name__ == "__main__":
    unittest.main()
