#!/usr/bin/env python3
"""Bot IO subprocess: holds live Devast.io sockets away from the orchestrator.

curl_cffi TLS can crash the interpreter natively (BAD_DECRYPT family), so all
curl_cffi work lives in this process. Control plane on 127.0.0.1:

  POST /connect {"id", "token", "proxy", "joinHex"} -> {"ok", "first", "host", "path"}
  GET  /status  -> {"bots": [{"id", "frames", "lastLen", "alive", "egress", "host", "path"}]}
  POST /close   -> closes every socket and stops the server

Connects are serialized: concurrent native handshakes crashed the process.
The reader thread owns its socket and replays the recorded c2s move-like frame
(status: hypothesis) as keepalive so idle bots are not dropped.
"""
from __future__ import annotations

import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from curl_cffi import requests as cffi_requests

ROOT = Path(__file__).resolve().parents[2]
HEADERS = {
    "Origin": "https://devast.io",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
    ),
}
KEEPALIVE_FRAME = bytes.fromhex("475bc8b9b24a6a12")  # recorded c2s move-like, hypothesis
CONNECT_LOCK = threading.Lock()

BOTS: dict[str, dict] = {}
BOTS_LOCK = threading.Lock()
SERVER_PATH = ""
KEEPALIVE_ENABLED = True


def connect_bot(bot_id: str, token: str, proxy: str | None, join: bytes) -> dict:
    egress = "direct" if proxy is None else "proxy"
    session = cffi_requests.Session(impersonate="chrome")
    if proxy:
        session.proxies = {"https": proxy, "http": proxy}
    with CONNECT_LOCK:
        ws = session.ws_connect(token, headers=HEADERS, timeout=15, proxy=proxy)
        ws.send_binary(join)
        data, _flags = ws.recv()
    path = urlparse(token).path
    if SERVER_PATH and path != SERVER_PATH:
        ws.close()
        return {"ok": False, "error": f"wrong server path {path} != {SERVER_PATH}"}
    bot = {
        "id": bot_id,
        "ws": ws,
        "session": session,
        "frames": 1,
        "lastLen": len(data),
        "first": len(data),
        "alive": True,
        "egress": egress,
        "host": urlparse(token).hostname or "",
        "path": path,
    }
    with BOTS_LOCK:
        BOTS[bot_id] = bot
    threading.Thread(target=reader, args=(bot,), daemon=True).start()
    return {"ok": True, "first": bot["first"], "host": bot["host"], "path": path, "egress": egress}


def reader(bot: dict) -> None:
    last_send = 0.0
    try:
        while bot["alive"]:
            data, _flags = bot["ws"].recv()
            with BOTS_LOCK:
                bot["frames"] += 1
                bot["lastLen"] = len(data)
            now = time.monotonic()
            if KEEPALIVE_ENABLED and now - last_send >= 0.9:
                bot["ws"].send_binary(KEEPALIVE_FRAME)
                last_send = now
    except Exception as error:
        with BOTS_LOCK:
            bot["alive"] = False
            bot["error"] = f"{type(error).__name__}: {str(error)[:140]}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass

    def _json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/status":
            with BOTS_LOCK:
                bots = [
                    {
                        "id": bot["id"],
                        "frames": bot["frames"],
                        "lastLen": bot["lastLen"],
                        "alive": bot["alive"],
                        "egress": bot["egress"],
                        "host": bot["host"],
                        "path": bot["path"],
                        "error": bot.get("error", ""),
                    }
                    for bot in BOTS.values()
                ]
            self._json({"bots": bots})
            return
        self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        if self.path == "/connect":
            try:
                join = bytes.fromhex(body["joinHex"])
            except (KeyError, ValueError) as error:
                self._json({"ok": False, "error": f"bad joinHex: {error}"})
                return
            proxy = body.get("proxy")
            try:
                result = connect_bot(str(body["id"]), str(body["token"]), proxy, join)
            except Exception as error:
                self._json({"ok": False, "error": f"{type(error).__name__}: {str(error)[:160]}"})
                return
            self._json(result)
            return
        if self.path == "/close":
            with BOTS_LOCK:
                for bot in BOTS.values():
                    bot["alive"] = False
                    try:
                        bot["ws"].close()
                    except Exception:
                        pass
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self._json({"ok": False, "error": "not found"}, 404)


def main() -> int:
    global KEEPALIVE_ENABLED
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--server", default="")
    parser.add_argument("--keepalive", choices=["on", "off"], default="on")
    args = parser.parse_args()
    KEEPALIVE_ENABLED = args.keepalive == "on"
    global SERVER_PATH
    SERVER_PATH = f"/{args.server}" if args.server else ""

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ok": True, "port": server.server_address[1]}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
