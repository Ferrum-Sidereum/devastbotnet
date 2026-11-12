#!/usr/bin/env python3
"""Chrome-TLS WebSocket transport for Devast.io.

Node's `ws` is rejected at the TLS layer (socket hang up). `curl_cffi` with a
Chrome impersonation profile completes the WebSocket handshake; this module
turns that into a small frame transport that can feed the recorder.

Usage:
  python tools/transport/chrome_ws.py \
    --url "wss://host/path?token" \
    --join-hex "475b..." \
    --sid cdp-python-1

Requires: pip install "curl_cffi>=0.16"
"""
from __future__ import annotations

import argparse
import base64
import json
import time
import urllib.request

from curl_cffi import requests

HEADERS = {
    "Origin": "https://devast.io",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
}


def post(recorder: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        recorder,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        response.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="wss:// URL with the query token")
    parser.add_argument("--join-hex", default="", help="hex-encoded first outbound frame")
    parser.add_argument("--sid", default=f"chrome-ws-{int(time.time())}")
    parser.add_argument("--recorder", default="http://127.0.0.1:8787/ingest")
    parser.add_argument("--seconds", type=float, default=30.0)
    args = parser.parse_args()

    session = requests.Session(impersonate="chrome")
    ws = session.ws_connect(args.url, headers=HEADERS, timeout=10)
    post(args.recorder, {"type": "hello", "sid": args.sid, "url": args.url, "userAgent": "chrome_ws.py"})
    print(f"[chrome-ws] connected {args.url.split('?')[0]}", flush=True)

    if args.join_hex:
        ws.send_binary(bytes.fromhex(args.join_hex))
        print(f"[chrome-ws] join sent {len(args.join_hex) // 2} B", flush=True)

    deadline = time.time() + args.seconds
    seq = 0
    try:
        while time.time() < deadline:
            data, flags = ws.recv()
            seq += 1
            kind = "text" if flags & 1 else "binary"
            post(
                args.recorder,
                {
                    "type": "frame",
                    "sid": args.sid,
                    "seq": seq,
                    "ts": int(time.time() * 1000),
                    "dir": "in",
                    "kind": kind,
                    "b64": base64.b64encode(data).decode("ascii"),
                    "url": args.url.split("?")[0],
                },
            )
            print(f"[chrome-ws] in {len(data)} B flags={flags}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            ws.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
