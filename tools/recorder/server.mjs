#!/usr/bin/env node
/**
 * Protocol recorder ingest server (Architecture v2, ADR-001).
 *
 * Binds 127.0.0.1 only. Accepts frames from the Tampermonkey sniffer over
 * WebSocket or HTTP POST and writes an append-only session:
 *
 *   sessions/<sid>-<ts>/index.jsonl   one record per frame (offset into frames.bin)
 *   sessions/<sid>-<ts>/frames.bin    raw payloads
 *   sessions/<sid>-<ts>/actions.jsonl key/mouse/mark events for correlation
 *   sessions/<sid>-<ts>/meta.json     hello/url/user-agent
 *   sessions/<sid>-<ts>/summary.json  counters and opcode candidates
 *
 * Frames are stored exactly as received; base64 is only a transport detail.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = resolve(here, "../../sessions");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const ALLOWED_ORIGINS = new Set(["https://devast.io", "https://www.devast.io", "http://devast.io"]);

function parseArgs(argv) {
  const options = { port: 8787, out: defaultOut, token: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--out") options.out = resolve(argv[++i]);
    else if (arg === "--token") options.token = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/recorder/server.mjs [--port 8787] [--out ./sessions] [--token secret]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error(`invalid --port: ${options.port}`);
  }
  return options;
}

function sanitizeSegment(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : fallback;
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function decodeBase64(b64, label) {
  if (typeof b64 !== "string" || b64.length === 0) {
    if (b64 === "") return Buffer.alloc(0);
    throw new Error(`${label}: missing base64 payload`);
  }
  if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
    throw new Error(`${label}: invalid base64`);
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length > MAX_FRAME_BYTES) {
    throw new Error(`${label}: frame too large (${buffer.length} B)`);
  }
  return buffer;
}

class SessionWriter {
  constructor(root, sid, hello) {
    this.sid = sid;
    this.dir = join(root, `${timestampSlug()}-${sanitizeSegment(sid, "session")}`);
    mkdirSync(this.dir, { recursive: true });
    this.framesPath = join(this.dir, "frames.bin");
    this.framesFd = openSync(this.framesPath, "a");
    this.bytesWritten = 0;
    this.indexLines = [];
    this.actionLines = [];
    this.meta = {
      sid,
      startedAt: new Date().toISOString(),
      ...hello,
    };
    this.stats = {
      frames: { in: 0, out: 0 },
      bytes: { in: 0, out: 0 },
      actions: 0,
      unknownKinds: 0,
      duplicateSeq: 0,
      seenSeq: { in: new Set(), out: new Set() },
      lengthHistogram: new Map(),
      firstByte: new Map(),
      u16le: new Map(),
      u16be: new Map(),
    };
    writeFileSync(join(this.dir, "meta.json"), `${JSON.stringify(this.meta, null, 2)}\n`, "utf8");
    appendFileSync(join(this.dir, "actions.jsonl"), "", "utf8");
  }

  noteHello(payload) {
    Object.assign(this.meta, payload);
    writeFileSync(join(this.dir, "meta.json"), `${JSON.stringify(this.meta, null, 2)}\n`, "utf8");
  }

  pushFrame(event) {
    const dir = event.dir === "in" ? "in" : event.dir === "out" ? "out" : null;
    if (dir === null) throw new Error(`frame: invalid dir "${event.dir}"`);
    const payload = decodeBase64(event.b64, "frame");
    const seq = Number(event.seq);
    if (!Number.isInteger(seq) || seq < 0) throw new Error("frame: invalid seq");

    if (this.stats.seenSeq[dir].has(seq)) this.stats.duplicateSeq += 1;
    this.stats.seenSeq[dir].add(seq);

    const offset = this.bytesWritten;
    if (payload.length > 0) writeSync(this.framesFd, payload);
    this.bytesWritten += payload.length;

    this.stats.frames[dir] += 1;
    this.stats.bytes[dir] += payload.length;
    bump(this.stats.lengthHistogram, payload.length);
    if (payload.length > 0) {
      bump(this.stats.firstByte, payload[0]);
      if (payload.length >= 2) {
        bump(this.stats.u16le, payload.readUInt16LE(0));
        bump(this.stats.u16be, payload.readUInt16BE(0));
      }
    }

    this.indexLines.push(
      JSON.stringify({
        seq,
        dir,
        kind: event.kind === "text" ? "text" : "binary",
        ts: Number(event.ts) || Date.now(),
        agentTs: event.agentTs === undefined ? null : Number(event.agentTs),
        len: payload.length,
        offset,
        sha256: createHash("sha256").update(payload).digest("hex").slice(0, 16),
        url: typeof event.url === "string" ? redactUrl(event.url) : undefined,
      }),
    );
    if (this.indexLines.length >= 128) this.flushIndex();
  }

  pushAction(event) {
    this.stats.actions += 1;
    this.actionLines.push(
      JSON.stringify({
        ts: Number(event.ts) || Date.now(),
        agentTs: event.agentTs === undefined ? null : Number(event.agentTs),
        action: event.action ?? null,
        label: event.label ?? null,
      }),
    );
    if (this.actionLines.length >= 128) this.flushActions();
  }

  flushIndex() {
    if (this.indexLines.length === 0) return;
    appendFileSync(join(this.dir, "index.jsonl"), `${this.indexLines.join("\n")}\n`, "utf8");
    this.indexLines = [];
  }

  flushActions() {
    if (this.actionLines.length === 0) return;
    appendFileSync(join(this.dir, "actions.jsonl"), `${this.actionLines.join("\n")}\n`, "utf8");
    this.actionLines = [];
  }

  summary() {
    const top = (map, limit = 12) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }));
    return {
      sid: this.sid,
      dir: this.dir,
      updatedAt: new Date().toISOString(),
      frames: this.stats.frames,
      bytes: this.stats.bytes,
      actions: this.stats.actions,
      duplicateSeq: this.stats.duplicateSeq,
      topLengths: top(this.stats.lengthHistogram, 20),
      topFirstByte: top(this.stats.firstByte, 20),
      topU16le: top(this.stats.u16le, 20),
      topU16be: top(this.stats.u16be, 20),
    };
  }

  writeSummary() {
    this.flushIndex();
    this.flushActions();
    writeFileSync(join(this.dir, "summary.json"), `${JSON.stringify(this.summary(), null, 2)}\n`, "utf8");
  }

  close() {
    this.writeSummary();
    closeSync(this.framesFd);
  }
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.slice(0, 200);
  }
}

function originAllowed(origin) {
  if (origin === undefined || origin === "" || origin === "null") return true;
  return ALLOWED_ORIGINS.has(origin);
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const sessions = new Map();
let globalEvents = 0;

function sessionFor(sid, hello) {
  const key = sanitizeSegment(sid, "unknown");
  let session = sessions.get(key);
  if (session === undefined) {
    session = new SessionWriter(options.out, key, hello ?? {});
    sessions.set(key, session);
    console.log(`[recorder] new session ${session.dir}`);
  } else if (hello !== undefined) {
    session.noteHello(hello);
  }
  return session;
}

function handleEvent(event) {
  if (typeof event !== "object" || event === null) return;
  if (event.type === "hello") {
    sessionFor(event.sid, {
      url: typeof event.url === "string" ? redactUrl(event.url) : undefined,
      userAgent: typeof event.userAgent === "string" ? event.userAgent.slice(0, 300) : undefined,
      binaryType: event.binaryType,
      pageTs: event.ts,
    });
    return;
  }
  if (event.type === "batch") {
    if (!Array.isArray(event.events)) throw new Error("batch: events must be an array");
    for (const item of event.events) handleEvent({ ...item, sid: item.sid ?? event.sid });
    return;
  }
  if (event.type === "frame") {
    sessionFor(event.sid).pushFrame(event);
    globalEvents += 1;
    return;
  }
  if (event.type === "action" || event.type === "mark") {
    sessionFor(event.sid).pushAction(event);
    return;
  }
  throw new Error(`unknown event type "${event.type}"`);
}

function handleBody(body, contentType) {
  if (contentType !== undefined && !contentType.includes("application/json")) {
    throw new Error(`unsupported content-type "${contentType}"`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`);
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) handleEvent(item);
  } else if (parsed.type === "batch") {
    handleEvent(parsed);
  } else {
    handleEvent(parsed);
  }
}

function tokenOk(request, url) {
  if (options.token === null) return true;
  const headerToken = request.headers["x-devast-token"];
  return headerToken === options.token || url.searchParams.get("token") === options.token;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (!originAllowed(request.headers.origin)) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        events: globalEvents,
        sessions: [...sessions.values()].map((session) => session.summary()),
      }),
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/summary") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([...sessions.values()].map((session) => session.summary()), null, 2));
    return;
  }

  if (request.method === "POST" && url.pathname === "/ingest") {
    if (!tokenOk(request, url)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "bad token" }));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "body too large" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      try {
        handleBody(Buffer.concat(chunks).toString("utf8"), request.headers["content-type"]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "not found" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/ingest" || !originAllowed(request.headers.origin) || !tokenOk(request, url)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        handleBody(data.toString("utf8"), "application/json");
      } catch (error) {
        console.error(`[recorder] ws ingest error: ${error.message}`);
      }
    });
    ws.on("error", (error) => console.error(`[recorder] ws error: ${error.message}`));
  });
});

const timer = setInterval(() => {
  for (const session of sessions.values()) {
    session.writeSummary();
  }
  const summary = [...sessions.values()]
    .map((session) => {
      const frames = session.stats.frames;
      return `${session.sid}: in=${frames.in} out=${frames.out}`;
    })
    .join(" | ");
  if (summary.length > 0) console.log(`[recorder] ${summary}`);
}, 5000);
timer.unref();

function shutdown(signal) {
  console.log(`\n[recorder] ${signal}: flushing sessions`);
  clearInterval(timer);
  for (const session of sessions.values()) {
    try {
      session.close();
    } catch (error) {
      console.error(`[recorder] close failed for ${session.sid}: ${error.message}`);
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(options.port, "127.0.0.1", () => {
  console.log(`[recorder] listening on http://127.0.0.1:${options.port}/ingest`);
  console.log(`[recorder] sessions dir: ${options.out}`);
  if (options.token !== null) console.log("[recorder] token required (x-devast-token)");
});

