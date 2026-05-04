import json
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from wiki_helper.app import create_server
from wiki_helper.config import HelperConfig


class StaticRawSourceReader:
    def __init__(self, notes=None):
        self.notes = notes or {}

    def read_note(self, app_name, note_path):
        return self.notes.get((app_name, note_path))


class AppTests(unittest.TestCase):
    def setUp(self):
        self.server = None
        self.thread = None
        self.base_url = ""
        self.start_server()

    def start_server(self, config=None, state=None):
        self.stop_server()
        resolved_config = config or HelperConfig(host="127.0.0.1", port=0)
        self.server = create_server(resolved_config, state=state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.base_url = f"http://{host}:{port}"

    def tearDown(self):
        self.stop_server()

    def stop_server(self):
        if not self.server:
            return
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.server = None
        self.thread = None
        self.base_url = ""

    def test_health(self):
        with urlopen(f"{self.base_url}/health", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["service"], "wiki-helper")
        self.assertEqual(payload["embeddingProvider"], "fake")

    def test_post_stub(self):
        request = Request(
            f"{self.base_url}/search-wiki",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as raised:
            urlopen(request, timeout=2)
        self.assertEqual(raised.exception.code, 501)

    def test_sanitize_and_index_note(self):
        sanitize_request = Request(
            f"{self.base_url}/sanitize-note",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "rawMarkdown": "Taylor owns db01.internal.",
                "terms": {"person": ["Taylor"], "host": ["db01.internal"]},
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(sanitize_request, timeout=2) as response:
            sanitized = json.loads(response.read().decode("utf-8"))

        self.assertIn("[[PRIVATE:PERSON:", sanitized["sanitizedMarkdown"])
        self.assertIn("[[PRIVATE:HOST:", sanitized["sanitizedMarkdown"])

        index_request = Request(
            f"{self.base_url}/index-note",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "sanitizedMarkdown": sanitized["sanitizedMarkdown"],
                "rawContentHash": sanitized["rawContentHash"],
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(index_request, timeout=2) as response:
            indexed = json.loads(response.read().decode("utf-8"))

        self.assertEqual(indexed["chunkCount"], 1)
        self.assertTrue(indexed["changed"])
        self.assertEqual(indexed["chunks"][0]["embeddingDimensions"], 1536)

    def test_reveal_text(self):
        sanitize_request = Request(
            f"{self.base_url}/sanitize-note",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "rawMarkdown": "Ask Taylor.",
                "terms": {"person": ["Taylor"]},
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(sanitize_request, timeout=2) as response:
            sanitized = json.loads(response.read().decode("utf-8"))

        reveal_request = Request(
            f"{self.base_url}/reveal-text",
            data=json.dumps({"sanitizedText": sanitized["sanitizedMarkdown"]}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(reveal_request, timeout=2) as response:
            revealed = json.loads(response.read().decode("utf-8"))

        self.assertEqual(revealed["text"], "Ask Taylor.")
        self.assertEqual(revealed["unresolvedPlaceholders"], [])
        self.assertEqual(revealed["source"], "placeholderMap")
        self.assertEqual(revealed["sensitiveValues"][0]["text"], "Taylor")

    def test_reveal_text_prefers_synced_raw_source(self):
        from wiki_helper.app import HelperState

        self.start_server(state=HelperState(raw_source_reader=StaticRawSourceReader({
            ("wiki", "notes/test.md"): "# Raw From Taylor\n",
        })))

        sanitize_request = Request(
            f"{self.base_url}/sanitize-note",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "rawMarkdown": "Ask Taylor.",
                "terms": {"person": ["Taylor"]},
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(sanitize_request, timeout=2) as response:
            sanitized = json.loads(response.read().decode("utf-8"))

        reveal_request = Request(
            f"{self.base_url}/reveal-text",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "sanitizedText": sanitized["sanitizedMarkdown"],
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(reveal_request, timeout=2) as response:
            revealed = json.loads(response.read().decode("utf-8"))

        self.assertEqual(revealed["text"], "# Raw From Taylor\n")
        self.assertEqual(revealed["unresolvedPlaceholders"], [])
        self.assertEqual(revealed["source"], "rawSource")
        self.assertEqual(revealed["sensitiveValues"][0]["text"], "Taylor")

    def test_reveal_text_can_skip_synced_raw_source(self):
        from wiki_helper.app import HelperState

        self.start_server(state=HelperState(raw_source_reader=StaticRawSourceReader({
            ("wiki", "notes/test.md"): "# Raw From Database\n",
        })))

        sanitize_request = Request(
            f"{self.base_url}/sanitize-note",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "rawMarkdown": "Ask Taylor.",
                "terms": {"person": ["Taylor"]},
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(sanitize_request, timeout=2) as response:
            sanitized = json.loads(response.read().decode("utf-8"))

        reveal_request = Request(
            f"{self.base_url}/reveal-text",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "sanitizedText": sanitized["sanitizedMarkdown"],
                "preferRawSource": False,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(reveal_request, timeout=2) as response:
            revealed = json.loads(response.read().decode("utf-8"))

        self.assertEqual(revealed["text"], "Ask Taylor.")
        self.assertEqual(revealed["unresolvedPlaceholders"], [])
        self.assertEqual(revealed["source"], "placeholderMap")

    def test_reveal_text_falls_back_when_raw_source_missing(self):
        from wiki_helper.app import HelperState

        self.start_server(state=HelperState(raw_source_reader=StaticRawSourceReader()))

        sanitize_request = Request(
            f"{self.base_url}/sanitize-note",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "rawMarkdown": "Ask Taylor.",
                "terms": {"person": ["Taylor"]},
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(sanitize_request, timeout=2) as response:
            sanitized = json.loads(response.read().decode("utf-8"))

        reveal_request = Request(
            f"{self.base_url}/reveal-text",
            data=json.dumps({
                "appName": "wiki",
                "path": "notes/test.md",
                "sanitizedText": sanitized["sanitizedMarkdown"],
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(reveal_request, timeout=2) as response:
            revealed = json.loads(response.read().decode("utf-8"))

        self.assertEqual(revealed["text"], "Ask Taylor.")
        self.assertEqual(revealed["unresolvedPlaceholders"], [])


if __name__ == "__main__":
    unittest.main()
