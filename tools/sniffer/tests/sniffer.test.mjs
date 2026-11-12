#!/usr/bin/env node
/**
 * Headless harness for the Tampermonkey sniffer.
 *
 * Runs the userscript in a vm context with a fake WebSocket and asserts that:
 *   - game frames are captured in both directions;
 *   - the native send is called with the original payload;
 *   - the tap's own socket is not instrumented (no recursion);
 *   - key/mouse actions are recorded for correlation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scriptPath = new URL("../master-client-sniffer.user.js", import.meta.url);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    this.url = String(url);
    this.protocols = protocols;
    this.readyState = FakeWebSocket.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
    this.listeners = new Map();
    this.onopen = null;
    this.__onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (typeof this.onopen === "function") this.onopen({});
    }, 0);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((item) => item !== handler),
    );
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    if (typeof this.onclose === "function") this.onclose({});
  }

  dispatchMessage(data) {
    const event = { data };
    for (const handler of this.listeners.get("message") ?? []) handler(event);
    if (typeof this.onmessage === "function") this.onmessage(event);
  }
}

const nativeOnMessage = {
  configurable: true,
  enumerable: true,
  get() {
    return this.__onmessage ?? null;
  },
  set(handler) {
    this.__onmessage = typeof handler === "function" ? handler : null;
  },
};
Object.defineProperty(FakeWebSocket.prototype, "onmessage", nativeOnMessage);

function makeSandbox() {
  const listeners = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setImmediate,
    TextEncoder,
    TextDecoder,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    encodeURIComponent,
    decodeURIComponent,
    performance: { now: () => 1234.5 },
    location: { href: "https://devast.io/game" },
    navigator: { userAgent: "devast-tap-harness" },
    localStorage: { getItem: () => null },
    addEventListener: (type, handler) => listeners.push([type, handler]),
    WebSocket: FakeWebSocket,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__listeners = listeners;
  return sandbox;
}

const nativeSend = FakeWebSocket.prototype.send;
const nativeAddEventListener = FakeWebSocket.prototype.addEventListener;

function resetFakePrototype() {
  FakeWebSocket.prototype.send = nativeSend;
  FakeWebSocket.prototype.addEventListener = nativeAddEventListener;
  Object.defineProperty(FakeWebSocket.prototype, "onmessage", nativeOnMessage);
  FakeWebSocket.instances.length = 0;
}

async function installTap() {
  resetFakePrototype();
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  context.window = context;
  context.self = context;
  context.unsafeWindow = context;
  context.globalThis = context;
  vm.runInContext(readFileSync(scriptPath, "utf8"), context, { filename: "master-client-sniffer.user.js" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return context;
}

function tapSocket() {
  return FakeWebSocket.instances.find((socket) => socket.url.startsWith("ws://127.0.0.1:8787"));
}

function gameSocket() {
  return FakeWebSocket.instances.find((socket) => socket.url === "wss://game.devast.io/ws");
}

function framesFromTap(socket) {
  const frames = [];
  for (const raw of socket.sent) {
    if (typeof raw !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.type === "batch") {
      frames.push(...parsed.events.filter((event) => event.type === "frame"));
    } else if (parsed.type === "frame") {
      frames.push(parsed);
    }
  }
  return frames;
}

function actionsFromTap(socket) {
  const actions = [];
  for (const raw of socket.sent) {
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === "batch") {
        actions.push(...parsed.events.filter((event) => event.type === "action" || event.type === "mark"));
      }
    } catch {
      // ignore
    }
  }
  return actions;
}

test("captures outbound and inbound frames without altering the payload", async () => {
  const context = await installTap();
  const tap = tapSocket();
  assert.ok(tap, "tap socket must exist");

  const game = new context.WebSocket("wss://game.devast.io/ws");
  assert.equal(game, FakeWebSocket.instances.find((socket) => socket.url === "wss://game.devast.io/ws"));
  assert.notEqual(FakeWebSocket.prototype.send, nativeSend, "prototype send must be patched");
  assert.equal(game.send, FakeWebSocket.prototype.send, "game sockets use the prototype hook");

  const outbound = new Uint8Array([1, 2, 3]).buffer;
  game.send(outbound);
  context.__devastTap.flush();

  const outFrames = framesFromTap(tap).filter((frame) => frame.dir === "out");
  assert.equal(outFrames.length, 1);
  assert.equal(outFrames[0].len, 3);
  assert.equal(outFrames[0].hex, "01 02 03");
  assert.equal(Buffer.from(outFrames[0].b64, "base64").toString("hex"), "010203");
  assert.deepEqual([...outFrames[0].views.i8], [1, 2, 3]);
  assert.equal(game.sent.length, 1, "native send must be called exactly once");
  assert.equal(game.sent[0], outbound, "native send must receive the original payload");

  game.dispatchMessage(new Uint8Array([9, 8, 7, 6]).buffer);
  context.__devastTap.flush();

  const inFrames = framesFromTap(tap).filter((frame) => frame.dir === "in");
  assert.equal(inFrames.length, 1);
  assert.equal(inFrames[0].hex, "09 08 07 06");
  assert.deepEqual([...inFrames[0].views.i8], [9, 8, 7, 6]);
});

test("onmessage-only sockets are instrumented through the prototype hook", async () => {
  const context = await installTap();
  const tap = tapSocket();
  const nativeSocket = new FakeWebSocket("wss://native.devast.io/ws");
  nativeSocket.onmessage = () => {
    // The game handler stays untouched.
  };
  nativeSocket.dispatchMessage(new Uint8Array([4, 5, 6]).buffer);
  context.__devastTap.flush();

  const frames = framesFromTap(tap).filter(
    (frame) => frame.dir === "in" && String(frame.url).includes("native.devast.io"),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].hex, "04 05 06");
});

test("captures keyboard and mouse actions with timestamps", async () => {
  const context = await installTap();
  const tap = tapSocket();
  const keydown = context.__listeners.find(([type]) => type === "keydown");
  assert.ok(keydown, "keydown listener must be registered");
  keydown[1]({
    repeat: false,
    key: "w",
    code: "KeyW",
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
  });
  const mousedown = context.__listeners.find(([type]) => type === "mousedown");
  assert.ok(mousedown);
  mousedown[1]({ button: 0, clientX: 640, clientY: 360, target: { tagName: "CANVAS" } });

  context.__devastTap.mark("axe-on-tree");
  context.__devastTap.flush();

  const actions = actionsFromTap(tap);
  assert.equal(actions.filter((event) => event.type === "action").length, 2);
  const mark = actions.find((event) => event.type === "mark");
  assert.equal(mark.label, "axe-on-tree");
  assert.ok(actions.every((event) => Number.isFinite(event.ts)));
});

test("tap socket is not instrumented and does not recurse", async () => {
  const context = await installTap();
  const tap = tapSocket();
  assert.equal(tap.__devastTapInternal, true, "tap socket must be marked internal");
  assert.equal(tap.listeners.get("message")?.length ?? 0, 0, "tap socket must not listen to its own messages");

  const game = new context.WebSocket("wss://game.devast.io/ws");
  game.send(new Uint8Array([5]).buffer);
  context.__devastTap.flush();

  const tapFrames = framesFromTap(tap);
  assert.equal(tapFrames.length, 1);
  assert.ok(tap.sent.every((raw) => typeof raw === "string"), "tap traffic is control JSON only");
});
