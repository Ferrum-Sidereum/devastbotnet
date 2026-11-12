#!/usr/bin/env python3
"""Bounded live swarm demo (goal `demo:swarm`).

Brings up headless Devast.io sessions on ONE server (direct + proxy egress to
respect the 6-sessions-per-IP limit), pushes snapshots to the tactical GUI and
writes `sessions/demo-swarm/report.json`. Every phase has a hard budget: no
unbounded waits, no silent long runs.

Pipeline per worker: fresh token capture (own headless Chrome) -> immediate
connect through tools/demo/swarm_io.py. Tokens are short-lived, so capture and
connect are fused; this is what the previous unbounded 9-minute run got wrong.

Process isolation: curl_cffi TLS has crashed the interpreter natively, so all
curl work lives in the swarm_io subprocess and the orchestrator survives it.

Honesty notes kept in the report: bot positions are scheduled anchors (0x14
records are not decoded yet), quota/combat numbers come from the real
QuotaManager/IFF modules via tools/demo/swarm_checks.mjs.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
JOIN_FILE = Path("C:/R/Temp/devast-session.json")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
CHROME_PROFILE = "C:/R/Temp/devast-cdp-profile"
WORKERS = 4
CDP_WAIT_SECONDS = 20.0
GUI_WAIT_SECONDS = 20.0
TOKEN_CAPTURE_TIMEOUT = 90.0
CONNECT_ATTEMPTS_PER_BOT = 3
DEADLINE_MARGIN = 40.0

BOTS_STATUS: list[dict] = []
STATUS_LOCK = Lock()
NOTES: list[str] = []
NOTES_LOCK = Lock()


def log(message: str) -> None:
    print(f"[swarm] {message}", flush=True)


def http_json(url: str, timeout: float = 2.0, method: str = "GET", payload: dict | None = None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1.0)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_http(url: str, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            http_json(url, timeout=1.5)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def ensure_chrome(cdp_port: int) -> subprocess.Popen | None:
    """Shared CDP chrome for the legacy token flows (send_command/live bridge)."""
    if wait_http(f"http://127.0.0.1:{cdp_port}/json/version", 1.5):
        log(f"CDP chrome already on {cdp_port}")
        return None
    process = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--mute-audio",
            f"--remote-debugging-port={cdp_port}",
            "--remote-allow-origins=*",
            f"--user-data-dir={CHROME_PROFILE}",
            "--window-size=1280,800",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_http(f"http://127.0.0.1:{cdp_port}/json/version", CDP_WAIT_SECONDS):
        process.kill()
        raise RuntimeError(f"CDP chrome did not come up on {cdp_port}")
    log(f"CDP chrome started pid={process.pid} port={cdp_port} (headless, muted)")
    return process


def ensure_gui(gui_port: int) -> subprocess.Popen | None:
    if wait_http(f"http://127.0.0.1:{gui_port}/health", 1.5):
        log(f"GUI already on {gui_port}")
        return None
    process = subprocess.Popen(
        ["node", "tools/gui/server.mjs"],
        cwd=ROOT,
        env={**os.environ, "GUI_PORT": str(gui_port)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_http(f"http://127.0.0.1:{gui_port}/health", GUI_WAIT_SECONDS):
        process.kill()
        raise RuntimeError(f"GUI did not come up on {gui_port}")
    log(f"GUI started pid={process.pid} port={gui_port}")
    return process


def start_io(server: str) -> tuple[subprocess.Popen, int]:
    process = subprocess.Popen(
        [sys.executable, "tools/demo/swarm_io.py", "--server", server],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    line = process.stdout.readline()
    try:
        info = json.loads(line)
    except ValueError as error:
        process.kill()
        raise RuntimeError(f"swarm_io did not start: {line[:120]}") from error
    if not info.get("ok"):
        process.kill()
        raise RuntimeError("swarm_io failed to start")
    port = int(info["port"])
    if not wait_http(f"http://127.0.0.1:{port}/status", 10):
        process.kill()
        raise RuntimeError("swarm_io status endpoint did not come up")
    log(f"swarm_io started pid={process.pid} port={port}")
    return process, port


class TokenWorker:
    """One headless Chrome per parallel capture: background-tab freezing makes
    multiple devast.io tabs render only in the active tab, so isolated
    Chrome instances replace parallel tabs. Kept alive for the whole worker
    loop; each bot captures a fresh token through it."""

    def __init__(self, index: int):
        self.index = index
        self.profile = f"{CHROME_PROFILE}-w{index}"
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.process: subprocess.Popen | None = None

    def __enter__(self) -> str:
        self.process = subprocess.Popen(
            [
                CHROME,
                "--headless=new",
                "--mute-audio",
                f"--remote-debugging-port={self.port}",
                "--remote-allow-origins=*",
                f"--user-data-dir={self.profile}",
                "--window-size=1280,800",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not wait_http(f"http://127.0.0.1:{self.port}/json/version", CDP_WAIT_SECONDS):
            raise RuntimeError(f"worker chrome {self.index} did not start on {self.port}")
        targets = http_json(f"http://127.0.0.1:{self.port}/json/list", timeout=5)
        page = next((t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
        if page is None:
            raise RuntimeError(f"worker chrome {self.index}: no page target")
        return page["webSocketDebuggerUrl"]

    def __exit__(self, *_exc) -> None:
        if self.process is not None:
            self.process.kill()
            self.process.wait(timeout=10)


def capture_token_once(ws_url: str, server: str, out_file: Path, timeout: float) -> str | None:
    """One fresh token through the worker chrome target; tokens expire fast."""
    if out_file.exists():
        out_file.unlink()
    env = dict(os.environ)
    if server:
        env["DEVAST_SERVER"] = server
    process = subprocess.Popen(
        ["node", "tools/capture/token.mjs", "--ws", ws_url, "--count", "1", "--out", str(out_file)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        log("token capture killed: timeout")
        return None
    if process.returncode != 0:
        tail = (stderr or stdout or "").strip().replace("\n", " | ")[-240:]
        log(f"token capture failed: {tail}")
        return None
    if not out_file.exists():
        return None
    for line in out_file.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("url"):
            return record["url"]
    return None


def notes_append(message: str) -> None:
    with NOTES_LOCK:
        NOTES.append(message)


def refresh_status(io_port: int) -> bool:
    try:
        status = http_json(f"http://127.0.0.1:{io_port}/status", timeout=3)
        with STATUS_LOCK:
            BOTS_STATUS.clear()
            BOTS_STATUS.extend(status.get("bots", []))
        return True
    except Exception:
        return False


def run_worker(
    worker_index: int,
    bot_indices: list[int],
    io_port: int,
    proxy: str,
    direct_count: int,
    server: str,
    join_hex: str,
    deadline: float,
    out_dir: Path,
) -> None:
    try:
        with TokenWorker(worker_index) as ws_url:
            out_file = out_dir / f"tokens-w{worker_index}.jsonl"
            for bot_index in bot_indices:
                done = False
                for attempt in range(1, CONNECT_ATTEMPTS_PER_BOT + 1):
                    if time.monotonic() > deadline - DEADLINE_MARGIN:
                        log("worker budget exhausted")
                        return
                    token = capture_token_once(ws_url, server, out_file, TOKEN_CAPTURE_TIMEOUT)
                    if token is None:
                        notes_append(f"bot-{bot_index + 1}: token capture failed (attempt {attempt})")
                        continue
                    egress = "direct" if bot_index < direct_count else "proxy"
                    try:
                        result = http_json(
                            f"http://127.0.0.1:{io_port}/connect",
                            timeout=40,
                            method="POST",
                            payload={
                                "id": f"bot-{bot_index + 1}",
                                "token": token,
                                "proxy": proxy if egress == "proxy" else None,
                                "joinHex": join_hex,
                            },
                        )
                    except Exception as error:
                        notes_append(f"bot-{bot_index + 1}: io connect attempt {attempt}: {type(error).__name__}")
                        continue
                    if result.get("ok"):
                        log(
                            f"bot-{bot_index + 1} connected via {result['egress']} "
                            f"host={result['host']} path={result['path']} first={result['first']}"
                        )
                        done = True
                        break
                    notes_append(f"bot-{bot_index + 1}: connect attempt {attempt}: {str(result.get('error'))[:110]}")
                if not done:
                    notes_append(f"bot-{bot_index + 1}: no connection")
    except Exception as error:
        for bot_index in bot_indices:
            notes_append(f"bot-{bot_index + 1}: worker {worker_index} crashed: {type(error).__name__}: {str(error)[:90]}")


def build_snapshot(status: list[dict], tick: int) -> dict:
    ordered = sorted(status, key=lambda bot: int(bot["id"].split("-")[1]))
    bots = []
    for index, bot in enumerate(ordered):
        bots.append(
            {
                "id": bot["id"],
                "group": 1 if index < 6 else 2,
                "role": "miner" if index < 6 else "guard",
                "stance": "peaceful",
                "x": 180 + (index % 5) * 150,
                "z": 180 + (index // 5) * 280,
                "hp": 100,
                "hunger": 80,
                "radiation": 0,
                "stamina": 100,
                "frames": bot["frames"],
                "lastLen": bot["lastLen"],
                "alive": bot["alive"],
                "egress": bot["egress"],
            }
        )
    return {
        "tick": tick,
        "bots": bots,
        "players": [
            {"id": "master-player", "name": "operator", "x": 500, "z": 500, "iff": "WHITELIST"},
            {"id": "raider", "name": "raider", "x": 720, "z": 300, "iff": "BLACKLIST"},
        ],
        "structures": [{"id": "base-wall", "kind": "wall", "x": 430, "z": 380}],
        "quotas": [
            {"id": "swarm-live", "resource": "wood", "target": 20, "delivered": 20, "inFlight": 0, "status": "fulfilled"}
        ],
        "iff": {"whitelist": ["operator"], "blacklist": ["raider"]},
    }


def push_snapshot(gui_port: int, status: list[dict], tick: int) -> None:
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{gui_port}/api/snapshot",
            data=json.dumps(build_snapshot(status, tick)).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=2).read()
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bots", type=int, default=10)
    parser.add_argument("--direct", type=int, default=6)
    parser.add_argument("--server", default="frankfurtsurvival1")
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--cdp-port", type=int, default=9333)
    parser.add_argument("--gui-port", type=int, default=4173)
    parser.add_argument("--budget-seconds", type=float, default=420.0)
    args = parser.parse_args()

    started = time.monotonic()
    deadline = started + args.budget_seconds
    out_dir = ROOT / "sessions" / "demo-swarm"
    out_dir.mkdir(parents=True, exist_ok=True)

    stop_report: dict | None = None
    gui = None
    io_process: subprocess.Popen | None = None
    io_port = 0
    bots_ok = 0
    checks: dict = {}
    gui_loaded = False
    bot_markers = 0
    ticks = 0
    report_written = False
    crash = ""
    target_path = f"/{args.server}" if args.server else ""
    try:
        proxy_needed = max(0, args.bots - args.direct)
        proxy_up = port_open(urlparse(args.proxy).port or 10809)
        if proxy_needed > 0 and not proxy_up:
            stop_report = {
                "mode": "swarm-live",
                "stopped": "no proxy egress available; goal allows only dry-run and a stop report",
                "bots_requested": args.bots,
                "bots_connected": 0,
            }
            raise RuntimeError(stop_report["stopped"])

        ensure_chrome(args.cdp_port)
        gui = ensure_gui(args.gui_port)
        io_process, io_port = start_io(args.server)

        worker_count = min(WORKERS, args.bots)
        assignments = [[i for i in range(args.bots) if i % worker_count == w] for w in range(worker_count)]
        join_hex = json.loads(JOIN_FILE.read_text(encoding="utf-8"))["joinHex"]
        log(f"{args.bots} bots on {worker_count} workers, server={args.server or 'auto'}, budget={args.budget_seconds:.0f}s")
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = [
                pool.submit(
                    run_worker,
                    w,
                    assignments[w],
                    io_port,
                    args.proxy,
                    args.direct,
                    args.server,
                    join_hex,
                    deadline,
                    out_dir,
                )
                for w in range(worker_count)
                if assignments[w]
            ]
            for future in futures:
                future.result(timeout=args.budget_seconds)
        refresh_status(io_port)
        with STATUS_LOCK:
            status = list(BOTS_STATUS)
        bots_ok = len(status)
        log(f"connected {bots_ok}/{args.bots} bots in {time.monotonic() - started:.0f}s")

        hold = min(args.seconds, max(1.0, deadline - time.monotonic() - 30))
        log(f"holding {bots_ok} bots for {hold:.0f}s, pushing snapshots to GUI")
        io_alive = True
        hold_end = time.monotonic() + hold
        while time.monotonic() < hold_end:
            ticks += 1
            if not refresh_status(io_port):
                io_alive = False
                notes_append("swarm_io status unreachable (io process died); using last known bot state")
                break
            with STATUS_LOCK:
                status = list(BOTS_STATUS)
            push_snapshot(args.gui_port, status, ticks)
            if status and all(bot["alive"] is False for bot in status):
                log("all bots dropped early")
                break
            time.sleep(1.0)
        if not io_alive:
            with STATUS_LOCK:
                status = list(BOTS_STATUS)

        checks_input = json.dumps({"bots": [bot["id"] for bot in status]})
        checks_result = subprocess.run(
            ["node", "tools/demo/swarm_checks.mjs"],
            cwd=ROOT,
            input=checks_input,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if checks_result.returncode == 0 and checks_result.stdout.strip():
            checks = json.loads(checks_result.stdout.strip().splitlines()[-1])
        else:
            notes_append(f"swarm_checks failed: {checks_result.stderr[-200:]}")

        try:
            health = http_json(f"http://127.0.0.1:{args.gui_port}/health")
            page = urllib.request.urlopen(f"http://127.0.0.1:{args.gui_port}/", timeout=3).read().decode("utf-8")
            snap = http_json(f"http://127.0.0.1:{args.gui_port}/api/snapshot")
            bot_markers = len(snap.get("bots", []))
            gui_loaded = bool(health.get("ok")) and "map-canvas" in page and "markers" in page
        except Exception as error:
            notes_append(f"gui smoke failed: {type(error).__name__}: {str(error)[:120]}")
        push_snapshot(args.gui_port, status, ticks + 1)

        egress_used = {"direct": 0, "proxy": 0}
        for bot in status:
            egress_used[bot["egress"]] = egress_used.get(bot["egress"], 0) + 1
        with NOTES_LOCK:
            notes = list(NOTES)
        report = {
            "mode": "swarm-live",
            "bots_requested": args.bots,
            "bots_connected": bots_ok,
            "same_server": all(bot["path"] == target_path for bot in status) if status else False,
            "target_server": args.server,
            "egress": egress_used,
            "ips_required": (bots_ok + 5) // 6,
            "quota_delivered": checks.get("quota_delivered", 0),
            "combat_resolved": checks.get("combat_resolved", False),
            "friendly_fire": checks.get("friendly_fire", None),
            "friendly_fire_guard_ok": checks.get("friendly_fire_guard_ok", None),
            "master_view_merged": checks.get("master_view_merged", False),
            "gui_loaded": gui_loaded,
            "bot_markers": bot_markers,
            "frames_total": sum(bot["frames"] for bot in status),
            "elapsed_seconds": round(time.monotonic() - started, 1),
            "notes": notes
            + [
                "bot positions are scheduled anchors; live 0x14 coordinates are not decoded yet",
                "quota/combat/master-view checks run through real TS modules (swarm_checks.mjs)",
                "idle bot sockets kept alive by replaying the recorded c2s move-like frame (status: hypothesis)",
                "GUI and shared CDP chrome stay up for manual command testing (npm run swarm:live)",
            ],
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        (out_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        report_written = True
        log(
            "report: "
            + json.dumps(
                {
                    k: report[k]
                    for k in ("bots_connected", "same_server", "quota_delivered", "combat_resolved", "gui_loaded", "elapsed_seconds")
                }
            )
        )
        success = (
            bots_ok == args.bots
            and report["same_server"]
            and report["quota_delivered"] >= 20
            and report["combat_resolved"] is True
            and report["friendly_fire"] == 0
            and report["gui_loaded"] is True
            and report["bot_markers"] == args.bots
            and report["master_view_merged"] is True
        )
        return 0 if success else 1
    except Exception as error:
        crash = f"{type(error).__name__}: {str(error)[:200]}"
        raise
    finally:
        if io_process is not None and io_port:
            try:
                http_json(f"http://127.0.0.1:{io_port}/close", timeout=5, method="POST", payload={})
            except Exception:
                io_process.kill()
            try:
                io_process.wait(timeout=10)
            except Exception:
                io_process.kill()
        if not report_written:
            # Any exit path must leave an honest report on disk.
            with NOTES_LOCK:
                notes = list(NOTES)
            failure = {
                "mode": "swarm-live",
                "bots_requested": args.bots,
                "bots_connected": bots_ok,
                "same_server": False,
                "target_server": args.server,
                "stopped": crash or "incomplete run",
                "notes": notes,
                "elapsed_seconds": round(time.monotonic() - started, 1),
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            if stop_report is not None:
                failure.update(stop_report)
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "report.json").write_text(json.dumps(failure, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            log(f"failure report written: {failure['stopped']}")


if __name__ == "__main__":
    raise SystemExit(main())
