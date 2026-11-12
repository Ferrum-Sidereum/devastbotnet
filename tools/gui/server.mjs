#!/usr/bin/env node
/**
 * Local Tactical RTS GUI server (Architecture v2, ADR-004).
 *
 * Serves the GUI and a snapshot endpoint. The orchestrator can POST a real
 * snapshot; without one the server returns a deterministic 10-bot demo state
 * so the map and smoke checks work before live transport is available.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../src/gui", import.meta.url)));
const projectRoot = resolve(root, "../..");
const port = Number(process.env.GUI_PORT ?? 4173);
const host = "127.0.0.1";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let snapshot = null;
let ticks = 0;

function demoSnapshot() {
  ticks += 1;
  const bots = Array.from({ length: 10 }, (_, index) => ({
    id: `bot-${index + 1}`,
    group: index < 4 ? 1 : index < 7 ? 2 : 3,
    role: index < 4 ? "miner" : index < 7 ? "hauler" : "guard",
    stance: index < 7 ? "peaceful" : "aggressive",
    x: 180 + (index % 5) * 150,
    z: 180 + Math.floor(index / 5) * 280,
    hp: 80 + index,
    hunger: 70 - index,
    radiation: index % 3,
    stamina: 55 + index * 3,
    trail: [],
  }));
  return {
    tick: ticks,
    bots,
    players: [
      { id: "p1", name: "operator", x: 500, z: 500, iff: "WHITELIST" },
      { id: "p2", name: "ally", x: 620, z: 420, iff: "WHITELIST" },
      { id: "p3", name: "raider", x: 760, z: 300, iff: "BLACKLIST" },
      { id: "p4", name: "wanderer", x: 300, z: 700, iff: "NEUTRAL" },
    ],
    structures: [
      { id: "s1", kind: "wall", x: 430, z: 380 },
      { id: "s2", kind: "smelter", x: 470, z: 420 },
      { id: "s3", kind: "turret", x: 510, z: 350 },
      { id: "s4", kind: "computer", x: 520, z: 460 },
      { id: "s5", kind: "storage", x: 460, z: 480 },
      { id: "s6", kind: "tesla", x: 560, z: 390 },
      { id: "s7", kind: "wall", x: 400, z: 440 },
      { id: "s8", kind: "generator", x: 540, z: 430 },
    ],
    quotas: [
      { id: "q1", resource: "wood", target: 20, delivered: 20, inFlight: 0, status: "fulfilled" },
    ],
    iff: { whitelist: ["operator", "ally"], blacklist: ["raider"] },
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createGuiServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (url.pathname === "/health") {
      json(response, 200, { ok: true, port, hasSnapshot: snapshot !== null });
      return;
    }
    if (url.pathname === "/api/snapshot" && request.method === "GET") {
      json(response, 200, snapshot ?? demoSnapshot());
      return;
    }
    if (url.pathname === "/api/command" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const hex = String(body.hex ?? "").trim();
        if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
          json(response, 400, { ok: false, error: "hex must be an even-length hex string" });
          return;
        }
        const server = String(body.server ?? "").trim();
        if (server !== "" && !/^[a-z0-9_-]{1,32}$/.test(server)) {
          json(response, 400, { ok: false, error: "invalid server" });
          return;
        }
        const commandArgs = ["tools/demo/send_command.py", "--hex", hex];
        if (server !== "") commandArgs.push("--server", server);
        execFile(
          "python",
          commandArgs,
          { cwd: projectRoot, timeout: 90_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            const line = String(stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
            try {
              const parsed = JSON.parse(line);
              json(response, parsed.ok ? 200 : 502, parsed);
              return;
            } catch {
              // fall through to the raw error
            }
            if (error) {
              json(response, 502, { ok: false, error: (stderr || error.message).slice(-500) });
              return;
            }
            json(response, 502, { ok: false, error: "empty command output" });
          },
        );
      } catch (error) {
        json(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/snapshot" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        json(response, 200, { ok: true });
      } catch (error) {
        json(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(root, requested));
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createGuiServer().listen(port, host, () => {
    console.log(`[gui] http://${host}:${port}`);
  });
}
