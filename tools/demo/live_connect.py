#!/usr/bin/env python3
"""Open live Devast.io sessions with per-bot browser tokens.

Each token is captured by tools/capture/token.mjs and used immediately with
curl_cffi's Chrome TLS profile. Direct and VPN-proxy egress are mixed to stay
within the 6-sessions-per-IP limit.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import time
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
        raise RuntimeError(f"token capture {attempt} failed: {result.stderr[-300:]}")
    url = URL_FILE.read_text(encoding="utf-8").strip()
    if not url.startswith("wss://"):
        raise RuntimeError(f"token capture {attempt} returned empty")
    return url


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bots", type=int, default=10)
    parser.add_argument("--direct", type=int, default=6)
    parser.add_argument("--seconds", type=float, default=12)
    parser.add_argument("--server", default="")
    args = parser.parse_args()
    if args.server:
        os.environ["DEVAST_SERVER"] = args.server
    else:
        os.environ.pop("DEVAST_SERVER", None)
    join = bytes.fromhex(json.loads(JOIN_FILE.read_text(encoding="utf-8"))["joinHex"])
    sessions = []
    results = []

    for index in range(args.bots):
        proxy = PROXY if index >= args.direct else None
        last_error = None
        for attempt in range(1, 6):
            try:
                url = capture_token(index * 10 + attempt)
                session = requests.Session(impersonate="chrome")
                if proxy:
                    session.proxies = {"https": proxy, "http": proxy}
                ws = session.ws_connect(
                url,
                headers=HEADERS,
                timeout=15,
                proxy=PROXY if proxy else None,
            )
                ws.send_binary(join)
                data, flags = ws.recv()
                sessions.append(ws)
                results.append({"bot": index + 1, "egress": "proxy" if proxy else "direct", "ok": True, "firstBytes": len(data), "flags": flags, "attempt": attempt, "host": urlparse(url).hostname, "path": urlparse(url).path})
                print(f"[live] {index + 1}/{args.bots} connected via {'proxy' if proxy else 'direct'} first={len(data)} attempt={attempt}", flush=True)
                last_error = None
                break
            except Exception as error:
                last_error = f"{type(error).__name__}: {str(error)[:160]}"
                print(f"[live] {index + 1} attempt {attempt} FAILED {last_error[:120]}", flush=True)
        if last_error is not None:
            results.append({"bot": index + 1, "egress": "proxy" if proxy else "direct", "ok": False, "error": last_error})

    Path("sessions/demo-swarm").mkdir(parents=True, exist_ok=True)
    report = {
        "mode": "live-connect",
        "bots_requested": args.bots,
        "bots_connected": sum(1 for item in results if item["ok"]),
        "results": results,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    Path("sessions/demo-swarm/live.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("bots_requested", "bots_connected")}), flush=True)
    time.sleep(args.seconds)
    for ws in sessions:
        try:
            ws.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
