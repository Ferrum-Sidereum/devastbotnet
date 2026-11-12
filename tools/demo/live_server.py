#!/usr/bin/env python3
"""Long-lived live swarm + command API for the tactical GUI.

Tokens are captured per bot with Chrome TLS, connections are held open, and
the GUI can send raw 0x47 hex commands to all/selected bots. This is the
command-testing bridge, not a claim that every game action is decoded yet.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from curl_cffi import requests

ROOT = Path(__file__).resolve().parents[2]
JOIN_FILE = Path("C:/R/Temp/devast-session.json")
URL_FILE = Path("C:/R/Temp/devast-ws-url.txt")
PROXY = "http://127.0.0.1:10809"
HEADERS = {
    "Origin": "https://devast.io",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
    ),
}

BOTS: list["Bot"] = []
LOCK = threading.Lock()
TICK = 0


class Bot:
    def __init__(self, bot_id: str, ws, first: int):
        self.id = bot_id
        self.ws = ws
        self.first = first
        self.frames = 1
        self.last_len = first
        self.last_flags = 0
        self.alive = True

    def reader(self) -> None:
        try:
            while self.alive:
                data, flags = self.ws.recv()
                with LOCK:
                    self.frames += 1
                    self.last_len = len(data)
                    self.last_flags = flags
        except Exception:
            self.alive = False


def capture_token(attempt: int) -> str:
    if URL_FILE.exists():
        URL_FILE.unlink()
    result = subprocess.run(
        ["node", "tools/capture/token.mjs", str(URL_FILE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=45,
    )
    if result.returncode != 0 or not URL_FILE.exists():
        raise RuntimeError(f"token {attempt}: {result.stderr[-200:]}")
    url = URL_FILE.read_text(encoding="utf-8").strip()
    if not url.startswith("wss://"):
        raise RuntimeError(f"token {attempt}: empty")
    return url


def connect_bot(index: int, direct: int, target_path: str, attempts: int = 6) -> Bot:
    join = bytes.fromhex(json.loads(JOIN_FILE.read_text(encoding="utf-8"))["joinHex"])
    proxy = PROXY if index >= direct else None
    last = None
    for attempt in range(1, attempts + 1):
        try:
            url = capture_token(index * 10 + attempt)
            if target_path and urlparse(url).path != target_path:
                last = f"path {urlparse(url).path} != {target_path}"
                continue
            session = requests.Session(impersonate="chrome")
            if proxy:
                session.proxies = {"https": proxy, "http": proxy}
            ws = session.ws_connect(url, headers=HEADERS, timeout=15)
            ws.send_binary(join)
            data, flags = ws.recv()
            bot = Bot(f"bot-{index + 1}", ws, len(data))
            bot.last_flags = flags
            threading.Thread(target=bot.reader, daemon=True).start()
            return bot
        except Exception as error:
            last = f"{type(error).__name__}: {str(error)[:100]}"
    raise RuntimeError(f"bot {index + 1}: {last}")


def snapshot() -> dict:
    with LOCK:
        bots = [
            {
                "id": bot.id,
                "group": 1 if index < 6 else 2,
                "role": "miner" if index < 6 else "guard",
                "stance": "peaceful",
                "x": 180 + (index % 5) * 150,
                "z": 180 + (index // 5) * 280,
                "hp": 100,
                "hunger": 80,
                "radiation": 0,
                "stamina": 100,
                "frames": bot.frames,
                "lastLen": bot.last_len,
                "alive": bot.alive,
            }
            for index, bot in enumerate(BOTS)
        ]
    return {
        "tick": TICK,
        "bots": bots,
        "players": [],
        "structures": [],
        "quotas": [],
        "iff": {"whitelist": ["operator"], "blacklist": []},
    }


class Handler(BaseHTTPRequestHandler):
    def cors(self) -> None:
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")

    def reply(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.cors()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200, {"ok": True, "bots": len(BOTS)})
        elif self.path == "/snapshot":
            self.reply(200, snapshot())
        else:
            self.reply(404, {"ok": False})

    def do_POST(self) -> None:
        if self.path != "/command":
            self.reply(404, {"ok": False})
            return
        length = int(self.headers.get("content-length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            raw = bytes.fromhex(str(body.get("hex", "")))
            targets = body.get("botIds", "all")
            with LOCK:
                selected = BOTS if targets == "all" else [b for b in BOTS if b.id in targets]
            sent = 0
            for bot in selected:
                try:
                    bot.ws.send_binary(raw)
                    sent += 1
                except Exception:
                    bot.alive = False
            self.reply(200, {"ok": True, "sent": sent, "bytes": len(raw)})
        except Exception as error:
            self.reply(400, {"ok": False, "error": str(error)[:160]})

    def log_message(self, *_args) -> None:
        pass


def push_gui() -> None:
    while True:
        try:
            data = json.dumps(snapshot()).encode("utf-8")
            req = urllib.request.Request(
                "http://127.0.0.1:4173/api/snapshot",
                data=data,
                headers={"content-type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            pass
        time.sleep(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bots", type=int, default=3)
    parser.add_argument("--direct", type=int, default=6)
    parser.add_argument("--path", default="/frankfurtsurvival1")
    parser.add_argument("--server", default="")
    parser.add_argument("--port", type=int, default=8788)
    args = parser.parse_args()

    if args.server:
        os.environ["DEVAST_SERVER"] = args.server
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=push_gui, daemon=True).start()
    print(f"[live] command API http://127.0.0.1:{args.port}", flush=True)

    for index in range(args.bots):
        try:
            bot = connect_bot(index, args.direct, args.path)
            with LOCK:
                BOTS.append(bot)
            print(f"[live] {bot.id} connected first={bot.first}", flush=True)
        except Exception as error:
            print(f"[live] bot {index + 1} failed: {error}", flush=True)

    report = {
        "mode": "live-command",
        "bots_connected": len(BOTS),
        "targetPath": args.path,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    Path("sessions/demo-swarm").mkdir(parents=True, exist_ok=True)
    Path("sessions/demo-swarm/live-command.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"[live] {len(BOTS)} bots online; Ctrl+C to stop", flush=True)
    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        pass
    for bot in BOTS:
        try:
            bot.ws.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
