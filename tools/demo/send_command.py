#!/usr/bin/env python3
"""One-shot live command test: fresh token, join, send raw hex, read replies."""
from __future__ import annotations

import argparse
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
HEADERS = {
    "Origin": "https://devast.io",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
    ),
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hex", required=True)
    parser.add_argument("--server", default="")
    parser.add_argument("--attempts", type=int, default=3)
    args = parser.parse_args()
    env = os.environ.copy()
    if args.server:
        env["DEVAST_SERVER"] = args.server
    else:
        env.pop("DEVAST_SERVER", None)
    join = bytes.fromhex(json.loads(JOIN_FILE.read_text(encoding="utf-8"))["joinHex"])
    last = None
    for attempt in range(1, args.attempts + 1):
        try:
            if URL_FILE.exists():
                URL_FILE.unlink()
            capture = subprocess.run(
                ["node", "tools/capture/token.mjs", str(URL_FILE)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=45,
                env=env,
            )
            if capture.returncode != 0:
                raise RuntimeError(f"token capture: {capture.stderr[-200:]}")
            url = URL_FILE.read_text(encoding="utf-8").strip()
            session = requests.Session(impersonate="chrome")
            ws = session.ws_connect(url, headers=HEADERS, timeout=15)
            ws.send_binary(join)
            ws.send_binary(bytes.fromhex(args.hex))
            frames = []
            deadline = time.time() + 4
            while time.time() < deadline and len(frames) < 3:
                data, flags = ws.recv()
                frames.append({"len": len(data), "flags": flags, "head": data[:40].hex()})
            print(json.dumps({"ok": True, "sent": len(bytes.fromhex(args.hex)), "frames": frames, "attempt": attempt, "host": urlparse(url).hostname, "path": urlparse(url).path}))
            ws.close()
            return 0
        except Exception as error:
            last = f"{type(error).__name__}: {str(error)[:160]}"
    print(json.dumps({"ok": False, "error": last}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
