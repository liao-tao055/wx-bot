"""Local HTTP fixtures only: these tests never contact WeChat."""
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).parents[1] / "wechat-send-files.py"
spec = importlib.util.spec_from_file_location("wechat_sender", SCRIPT)
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


@contextmanager
def fixture():
    state = {"records": {}, "tickets": {}, "uploads": [], "calls": [], "external": False, "lost_reply": False, "logged_in": True}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, data, status=200):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            assert self.headers["User-Agent"] == "wx-bot-workspace/0.3.0"
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            name = body["params"]["name"]
            args = body["params"]["arguments"]
            state["calls"].append(name)
            if name == "wechat_status":
                result = {"logged_in": state["logged_in"], "expired": False, "context_available": True, "server_version": "0.3.0", "supported_file_types": "any", "max_file_bytes": sender.MAX_FILE_BYTES}
            elif name == "wechat_delivery_status":
                result = {"state": state["records"].get(args["delivery_id"], {}).get("state", "not_found")}
            elif name == "wechat_prepare_file_upload":
                ident = args["delivery_id"]
                fingerprint = [args["filename"], args["sha256"], args["task_title"]]
                previous = state["records"].get(ident)
                if previous and previous.get("fingerprint") != fingerprint:
                    self.reply({"result": {"isError": True, "structuredContent": {"error": {"message": "delivery_id was already used for different content"}}}})
                    return
                if previous and previous["state"] == "sent":
                    result = {"ok": True, "duplicate": True, "already_sent": True, "state": "sent"}
                else:
                    key = str(len(state["tickets"]))
                    state["tickets"][key] = {**args, "fingerprint": fingerprint}
                    host = "https://untrusted.invalid" if state["external"] else f"http://127.0.0.1:{self.server.server_port}"
                    result = {"upload_url": host + "/upload/PRIVATE_TICKET_" + key, "method": "PUT", "expires_at": (time.time() + 300) * 1000}
            else:
                raise AssertionError("Unexpected tool: " + name)
            self.reply({"result": {"structuredContent": result}})

        def do_PUT(self):
            assert self.headers["User-Agent"] == "wx-bot-workspace/0.3.0"
            ticket = state["tickets"][self.path.rsplit("_", 1)[1]]
            data = self.rfile.read(int(self.headers["Content-Length"]))
            assert len(data) == ticket["size_bytes"]
            assert hashlib.sha256(data).hexdigest() == ticket["sha256"]
            state["uploads"].append((ticket["filename"], data))
            state["records"][ticket["delivery_id"]] = {"state": "sent", "fingerprint": ticket["fingerprint"]}
            if state["lost_reply"]:
                self.close_connection = True
                return
            self.reply({"ok": True, "duplicate": False})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state, f"http://127.0.0.1:{server.server_port}/mcp/owner/PRIVATE_CONNECTION"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class SenderTests(unittest.TestCase):
    def run_cli(self, url, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              env={**os.environ, "WXBOT_MCP_URL": url},
                              text=True, capture_output=True, timeout=10)

    def args(self, path, scheduled="2026-11-01T11:00:00+08:00"):
        return ["--task-id", "stable-project", "--scheduled-for", scheduled, "--title", "文件交付", path]

    def test_different_timezone_representations_keep_the_same_id(self):
        a = sender.planned_time("2026-11-01T11:00:00+08:00")
        b = sender.planned_time("2026-11-01T03:00:00Z")
        self.assertEqual(sender.delivery_id("project", a, "说明.docx"), sender.delivery_id("project", b, "说明.docx"))
        with self.assertRaises(sender.DeliveryError):
            sender.planned_time("2026-11-01T11:00:00")

    def test_status_check_never_uploads(self):
        with fixture() as (state, url):
            result = self.run_cli(url, "--check")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(state["calls"], ["wechat_status"])
            self.assertEqual(state["uploads"], [])
            self.assertNotIn("PRIVATE_CONNECTION", result.stdout + result.stderr)

    def test_office_pdf_zip_and_opaque_bytes_are_preserved_and_deduplicated(self):
        with fixture() as (state, url), tempfile.TemporaryDirectory() as folder:
            paths = []
            for name in ["预测卷.pdf", "详解.docx", "分数.xlsx", "资料.zip", "notes.txt", "opaque.bin"]:
                path = Path(folder) / name
                path.write_bytes(bytes([0, 255, 128, 13, 10, 1]))
                paths.append(path)
            args = ["--task-id", "stable-project", "--scheduled-for", "2026-11-01T11:00:00+08:00", *paths]
            first = self.run_cli(url, *args)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(state["uploads"], [(p.name, p.read_bytes()) for p in paths])
            second = self.run_cli(url, *args)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(len(state["uploads"]), len(paths))
            self.assertTrue(all(json.loads(line)["duplicate"] for line in second.stdout.splitlines()))
            self.assertNotIn("PRIVATE_", first.stdout + first.stderr + second.stdout + second.stderr)

    def test_a_changed_file_cannot_reuse_an_already_sent_id(self):
        with fixture() as (state, url), tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data.xlsx"
            path.write_bytes(b"original")
            self.assertEqual(self.run_cli(url, *self.args(path)).returncode, 0)
            path.write_bytes(b"changed")
            result = self.run_cli(url, *self.args(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("different content", result.stderr)
            self.assertEqual(len(state["uploads"]), 1)

    def test_uncertain_is_not_reset_or_retried(self):
        with fixture() as (state, url), tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "report.docx"
            path.write_bytes(b"frozen")
            ident = sender.delivery_id("stable-project", sender.planned_time("2026-11-01T11:00:00+08:00"), path.name)
            state["records"][ident] = {"state": "uncertain"}
            result = self.run_cli(url, *self.args(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("uncertain", result.stderr)
            self.assertNotIn("wechat_prepare_file_upload", state["calls"])
            self.assertEqual(state["uploads"], [])

    def test_lost_upload_response_is_queried_without_resending(self):
        with fixture() as (state, url), tempfile.TemporaryDirectory() as folder:
            state["lost_reply"] = True
            path = Path(folder) / "file.zip"
            path.write_bytes(b"original bytes")
            result = self.run_cli(url, *self.args(path))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["verified_after_unknown_response"])
            self.assertEqual(len(state["uploads"]), 1)

    def test_server_cannot_redirect_upload_to_another_origin(self):
        with fixture() as (state, url), tempfile.TemporaryDirectory() as folder:
            state["external"] = True
            path = Path(folder) / "report.pdf"
            path.write_bytes(b"original bytes")
            result = self.run_cli(url, *self.args(path))
            self.assertEqual(result.returncode, 1)
            self.assertEqual(state["uploads"], [])
            self.assertNotIn("PRIVATE_", result.stderr)

    def test_preflight_stops_all_network_for_oversized_or_duplicate_names(self):
        with fixture() as (state, url), tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "too-large.bin"
            with path.open("wb") as stream:
                stream.truncate(sender.MAX_FILE_BYTES + 1)
            result = self.run_cli(url, *self.args(path))
            self.assertEqual(result.returncode, 1)
            self.assertEqual(state["calls"], [])
            path.write_bytes(b"small")
            result = self.run_cli(url, *self.args(path), path)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(state["calls"], [])

    def test_logged_out_check_is_an_error_and_never_sends(self):
        with fixture() as (state, url):
            state["logged_in"] = False
            result = self.run_cli(url, "--check")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(state["uploads"], [])


if __name__ == "__main__":
    unittest.main()
