#!/usr/bin/env node
/**
 * Live CDP WebSocket tap for an already-running Chrome game tab.
 *
 * Reads Chrome's DevToolsActivePort, attaches to every Devast.io page target,
 * enables the Network domain and ingests WebSocket frames into the local
 * recorder. It never navigates, reloads or closes a target: only
 * Target.attachToTarget + Network.enable + event listening.
 *
 * Usage:
 *   node tools/recorder/cdp-live.mjs [--devtools-file <path>] [--ingest <url>]
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const DEFAULT_DEVTOOLS = "C:/Users/Flusion/AppData/Local/Google/Chrome/User Data/DevToolsActivePort";
const DEFAULT_INGEST = "http://127.0.0.1:8787/ingest";

function parseArgs(argv) {
  const options = { devtoolsFile: DEFAULT_DEVTOOLS, ingest: DEFAULT_INGEST };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--devtools-file") options.devtoolsFile = argv[++i];
    else if (argv[i] === "--ingest") options.ingest = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node tools/recorder/cdp-live.mjs [--devtools-file <path>] [--ingest <url>]");
      process.exit(0);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const [port, browserPath] = readFileSync(options.devtoolsFile, "utf8").trim().split(/\r?\n/);
if (!port || !browserPath) throw new Error(`invalid DevToolsActivePort: ${options.devtoolsFile}`);
const browserUrl = `ws://127.0.0.1:${port}${browserPath}`;
const sessionPrefix = `cdp-${Date.now().toString(36)}`;

let nextId = 0;
let socket = null;
const pending = new Map();
const sessions = new Map();

function log(message) {
  console.log(`[cdp-live] ${message}`);
}

function send(method, params = {}, sessionId) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("CDP socket is not open"));
  }
  const id = ++nextId;
  const message = { id, method, params };
  if (sessionId !== undefined) message.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify(message));
  });
}

async function ingest(payload) {
  const response = await fetch(options.ingest, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`ingest HTTP ${response.status}`);
}

function track(sessionId, target) {
  const state = {
    sid: `${sessionPrefix}-${target.targetId.slice(0, 8)}`,
    url: target.url,
    seq: 0,
    batch: [],
    urls: new Map(),
    flushing: false,
  };
  sessions.set(sessionId, state);
  log(`attached ${state.sid} ${target.url}`);
  return state;
}

async function flush(state) {
  if (state.flushing || state.batch.length === 0) return;
  state.flushing = true;
  const events = state.batch;
  state.batch = [];
  try {
    await ingest({ type: "batch", sid: state.sid, events });
  } catch (error) {
    state.batch = [...events, ...state.batch];
    log(`ingest failed: ${error.message}`);
  } finally {
    state.flushing = false;
  }
}

function onFrame(sessionId, method, params) {
  const state = sessions.get(sessionId);
  if (state === undefined) return;
  if (method === "Network.webSocketCreated") {
    state.urls.set(params.requestId, params.url);
    return;
  }
  const response = params.response;
  if (response === undefined || typeof response.payloadData !== "string") return;
  const dir = method === "Network.webSocketFrameSent" ? "out" : "in";
  state.batch.push({
    type: "frame",
    sid: state.sid,
    seq: ++state.seq,
    ts: Date.now(),
    dir,
    kind: response.opcode === 1 ? "text" : "binary",
    b64: response.payloadData,
    url: state.urls.get(params.requestId) ?? state.url,
  });
}

async function attachPages() {
  const targets = await send("Target.getTargets");
  const pages = targets.targetInfos.filter(
    (target) => target.type === "page" && String(target.url).includes("devast.io"),
  );
  if (pages.length === 0) {
    log("no Devast.io page target yet; retrying");
    return 0;
  }
  for (const target of pages) {
    try {
      const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const sessionId = attached.sessionId;
      const state = track(sessionId, target);
      await send("Network.enable", {}, sessionId);
      await ingest({
        type: "hello",
        sid: state.sid,
        ts: Date.now(),
        url: target.url,
        userAgent: "cdp-live",
      });
    } catch (error) {
      log(`attach failed for ${target.url}: ${error.message}`);
    }
  }
  return pages.length;
}

function connect() {
  socket = new WebSocket(browserUrl);
  socket.on("open", async () => {
    log(`connected to ${browserUrl}`);
    try {
      await attachPages();
    } catch (error) {
      log(`initial attach error: ${error.message}`);
    }
  });
  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      sessions.delete(message.params.sessionId);
      log(`detached ${message.params.sessionId}`);
      return;
    }
    if (message.method && message.method.startsWith("Network.webSocket")) {
      onFrame(message.sessionId, message.method, message.params);
    }
  });
  socket.on("close", () => {
    log("CDP socket closed; reconnecting");
    for (const entry of pending.values()) entry.reject(new Error("CDP socket closed"));
    pending.clear();
    sessions.clear();
    setTimeout(connect, 2000);
  });
  socket.on("error", (error) => log(`socket error: ${error.message}`));
}

setInterval(() => {
  for (const state of sessions.values()) void flush(state);
}, 500);

setInterval(() => {
  for (const state of sessions.values()) {
    log(`${state.sid}: in/out total=${state.seq} queue=${state.batch.length}`);
  }
}, 10_000);

connect();
