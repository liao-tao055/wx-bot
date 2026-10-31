#!/usr/bin/env python3
"""Send authorized workspace artifacts through the private wx-bot MCP bridge.

Python standard library only. Connection credentials come from WXBOT_MCP_URL.
Never replaces an uncertain receipt or changes its delivery_id automatically.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_FILE_BYTES = 10 * 1024 * 1024


class DeliveryError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def safe_message(value: object) -> str:
    text = re.sub(r"https?://[^\s<>\"']+", "[private URL redacted]", str(value))
    secret = os.environ.get("WXBOT_MCP_URL", "")
    if secret:
        text = text.replace(secret, "[private connection redacted]")
    text = re.sub(r"(?i)(?:bearer\s+)\S+", "Bearer [redacted]", text)
    return re.sub(r"[\r\n\t]+", " ", text)[:500]


def checked_url(value: str) -> urllib.parse.SplitResult:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        raise DeliveryError("Invalid connection URL") from None
    loopback = parsed.hostname == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        pass
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)) or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise DeliveryError("Use a private HTTPS MCP connection (HTTP is allowed only for local tests)")
    if parsed.scheme == "https" and port not in (None, 443):
        raise DeliveryError("Use the HTTPS MCP endpoint on port 443")
    return parsed


def origin(parsed: urllib.parse.SplitResult) -> tuple[str, str, int]:
    return parsed.scheme, parsed.hostname or "", parsed.port or (443 if parsed.scheme == "https" else 80)


class Client:
    def __init__(self, url: str):
        self.url = url
        self.origin = origin(checked_url(url))
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, url: str, method: str, data: bytes, content_type: str) -> dict:
        req = urllib.request.Request(url, method=method, data=data, headers={
            "Content-Type": content_type, "Accept": "application/json",
            "User-Agent": "wx-bot-workspace/0.3.0",
        })
        try:
            with self.opener.open(req, timeout=120) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise DeliveryError("Response exceeds the permitted size")
        except urllib.error.HTTPError as err:
            # Do not log the secret capability URL, signed upload URL or headers.
            raise DeliveryError(f"HTTP {err.code}; no automatic resend") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DeliveryError("Network result is unknown; check the original delivery_id before retrying") from None
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise DeliveryError("Server returned invalid JSON; no automatic resend") from None
        if not isinstance(value, dict):
            raise DeliveryError("Server returned an invalid response object")
        return value

    def call(self, name: str, arguments: dict) -> dict:
        response = self.request(self.url, "POST", json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }, ensure_ascii=False).encode(), "application/json")
        if "error" in response:
            raise DeliveryError("MCP protocol error; check the connection and server version")
        result = response.get("result", {})
        if not isinstance(result, dict):
            raise DeliveryError("MCP result is missing")
        if result.get("isError"):
            error = result.get("structuredContent", {}).get("error", {})
            message = error.get("message") if isinstance(error, dict) else None
            if not message:
                message = " ".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))
            raise DeliveryError(safe_message(message or "MCP tool failed"))
        content = result.get("structuredContent")
        if not isinstance(content, dict):
            raise DeliveryError("MCP structured result is missing")
        return content

    def upload(self, ticket: dict, data: bytes) -> dict:
        url = ticket.get("upload_url", "")
        if not isinstance(url, str) or origin(checked_url(url)) != self.origin:
            raise DeliveryError("Upload URL must belong to the connected server")
        if ticket.get("method") != "PUT":
            raise DeliveryError("Unexpected upload method")
        expires = ticket.get("expires_at")
        if not isinstance(expires, (int, float)) or expires <= dt.datetime.now(dt.timezone.utc).timestamp() * 1000:
            raise DeliveryError("Upload ticket expired; prepare again with the SAME delivery_id")
        return self.request(url, "PUT", data, "application/octet-stream")


def planned_time(value: str) -> str:
    try:
        instant = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise DeliveryError("--scheduled-for must be an ISO timestamp with a timezone") from None
    if instant.utcoffset() is None:
        raise DeliveryError("--scheduled-for must include its timezone")
    # A UTC and Beijing representation of the same scheduled instant get one ID.
    return instant.astimezone(dt.timezone(dt.timedelta(hours=8))).isoformat()


def delivery_id(task_id: str, scheduled_for: str, filename: str) -> str:
    raw = f"{task_id}|{scheduled_for}|file:{filename}"
    return raw if len(raw) <= 200 else "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


def files_to_send(paths: list[str]) -> list[tuple[str, bytes]]:
    result = []
    seen = set()
    for raw in paths:
        path = Path(raw)
        name = path.name
        if not name.strip() or name in (".", "..") or len(name) > 180 or any(ord(c) < 32 or ord(c) == 127 or c in "/\\" for c in name):
            raise DeliveryError("Invalid attachment basename")
        if name in seen:
            raise DeliveryError("Attachments in one run must have distinct basenames")
        seen.add(name)
        if not path.is_file():
            raise DeliveryError(f"Attachment is not a regular file: {name}")
        if not 1 <= path.stat().st_size <= MAX_FILE_BYTES:
            raise DeliveryError(f"Attachment must have 1 byte to 10 MiB: {name}")
        data = path.read_bytes()  # Freeze the exact bytes before network calls.
        if not 1 <= len(data) <= MAX_FILE_BYTES:
            raise DeliveryError(f"Attachment changed or exceeds 10 MiB: {name}")
        result.append((name, data))
    return result


def send_file(client: Client, name: str, data: bytes, task_id: str, scheduled: str, title: str) -> dict:
    ident = delivery_id(task_id, scheduled, name)
    state = client.call("wechat_delivery_status", {"delivery_id": ident}).get("state")
    if state not in ("not_found", "retry_ready", "sent"):
        raise DeliveryError(f"{name}: delivery is {state}; stopped without resetting or resending")
    # Even when state=sent, prepare verifies that ID still means identical bytes.
    ticket = client.call("wechat_prepare_file_upload", {
        "delivery_id": ident, "task_title": title, "filename": name,
        "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
    })
    if ticket.get("already_sent") is True and ticket.get("state") == "sent" and ticket.get("ok") is True:
        return {"filename": name, "state": "sent", "duplicate": True}
    try:
        response = client.upload(ticket, data)
    except DeliveryError:
        # An HTTP timeout can happen AFTER acceptance. Query; never re-upload.
        try:
            current = client.call("wechat_delivery_status", {"delivery_id": ident}).get("state")
        except DeliveryError:
            current = "unknown"
        if current == "sent":
            return {"filename": name, "state": "sent", "verified_after_unknown_response": True}
        raise DeliveryError(f"{name}: upload/send result is {current}; no automatic resend") from None
    if response.get("ok") is not True:
        raise DeliveryError(f"{name}: server did not confirm acceptance; no automatic resend")
    verified = client.call("wechat_delivery_status", {"delivery_id": ident}).get("state")
    if verified != "sent":
        raise DeliveryError(f"{name}: final state is {verified}; no automatic resend")
    return {"filename": name, "state": "sent", "duplicate": response.get("duplicate") is True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Read status only; sends nothing")
    parser.add_argument("--task-id", help="Stable original project/task prefix, reused after migration")
    parser.add_argument("--scheduled-for", help="Actual planned ISO timestamp, including timezone")
    parser.add_argument("--title", default="")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    try:
        if args.check and args.files:
            raise DeliveryError("--check never accepts files or sends anything")
        if not args.check and (not args.files or not args.task_id or not args.scheduled_for):
            raise DeliveryError("Provide files, --task-id and --scheduled-for, or use --check")
        frozen = [] if args.check else files_to_send(args.files)
        scheduled = "" if args.check else planned_time(args.scheduled_for)
        if len(args.title) > 100 or any(ord(c) < 32 for c in args.title):
            raise DeliveryError("Task title must be one line and at most 100 characters")
        url = os.environ.get("WXBOT_MCP_URL", "")
        if not url:
            raise DeliveryError("WXBOT_MCP_URL is not configured; connect the private service first")
        client = Client(url)
        status = client.call("wechat_status", {})
        summary = {k: status.get(k) for k in ("server_version", "logged_in", "expired", "context_available", "max_file_bytes", "supported_file_types")}
        if args.check:
            print(json.dumps(summary, ensure_ascii=False))
            return 0 if status.get("logged_in") is True and status.get("expired") is False and status.get("context_available") is not False else 1
        if status.get("logged_in") is not True or status.get("expired") is not False:
            raise DeliveryError("WeChat login is missing or expired; nothing was sent")
        if status.get("context_available") is False:
            raise DeliveryError("No inbound context; message ClawBot first; nothing was sent")
        if status.get("supported_file_types") != "any":
            raise DeliveryError("The server has not enabled general attachments; deploy MCP 0.3.0 first")
        limit = status.get("max_file_bytes")
        if not isinstance(limit, int) or any(len(data) > limit for _, data in frozen):
            raise DeliveryError("An attachment exceeds the server limit; nothing was sent")
        for name, data in frozen:
            print(json.dumps(send_file(client, name, data, args.task_id, scheduled, args.title), ensure_ascii=False), flush=True)
        return 0
    except (DeliveryError, OSError) as err:
        print(json.dumps({"ok": False, "error": safe_message(err)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
