// ==UserScript==
// @name         Devast.io Master Client Sniffer
// @namespace    devastbotnet
// @version      0.1.0
// @description  Read-only WebSocket tap for Phase 0 protocol reverse engineering. Never modifies game traffic.
// @match        https://devast.io/*
// @match        https://*.devast.io/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

/**
 * Architecture v2, ADR-001/ADR-008.
 *
 * The tap observes:
 *   - outgoing frames by patching WebSocket.prototype.send once; the native
 *     send is called with the original arguments, byte for byte;
 *   - incoming frames via a message listener attached before the game receives
 *     the socket instance, plus WebSocket.prototype.onmessage and
 *     addEventListener("message") hooks for sockets created later.
 *
 * It never calls send() itself on a game socket and never rewrites payloads.
 * Transport goes to a separate local socket created from the saved native
 * constructor, so the tap cannot observe itself.
 */
(() => {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (page.__devastTapInstalled) return;
  page.__devastTapInstalled = true;

  const Native = page.WebSocket;
  if (typeof Native !== "function") {
    console.warn("[devast-tap] WebSocket is not available; tap not installed");
    return;
  }

  const CONFIG = {
    ingestUrl: "ws://127.0.0.1:8787/ingest",
    maxQueueEvents: 4000,
    maxBatchEvents: 200,
    maxBatchChars: 1_500_000,
    flushIntervalMs: 250,
    reconnectMs: 2000,
    maxFrameBytes: 1_048_576,
    hexBytes: 512,
    viewBytes: 256,
    wsBufferedLimit: 4_000_000,
  };

  const sid = `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const pageUrl = String(page.location?.href ?? "");
  const token = (() => {
    try {
      return page.localStorage?.getItem("__devastTapToken") ?? "";
    } catch {
      return "";
    }
  })();
  const query = token.length > 0 ? `?token=${encodeURIComponent(token)}` : "";
  const wsUrl = `${CONFIG.ingestUrl}${query}`;
  const httpUrl = `${CONFIG.ingestUrl.replace(/^ws/, "http")}${query}`;

  let enabled = true;
  let seq = 0;
  let dropped = 0;
  let framesIn = 0;
  let framesOut = 0;
  let queue = [];
  let pending = [];
  let flushTimer = null;
  let socket = null;
  let socketState = "idle";
  let reconnectTimer = null;
  let lastHttpAttempt = 0;
  let httpInFlight = false;
  let httpEnabled = typeof GM_xmlhttpRequest === "function";
  let warned = 0;

  const encoder = new TextEncoder();
  const originalAddListener = Native.prototype.addEventListener;
  const originalSend = Native.prototype.send;
  const originalOnMessage = Object.getOwnPropertyDescriptor(Native.prototype, "onmessage");
  const instrumented = new WeakSet();

  function warn(context, error) {
    if (warned >= 10) return;
    warned += 1;
    console.warn(`[devast-tap] ${context}:`, error);
  }

  function perfNow() {
    return typeof page.performance?.now === "function" ? page.performance.now() : Date.now();
  }

  function toBase64(bytes) {
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function hexOf(bytes, maxBytes) {
    const end = Math.min(bytes.length, maxBytes);
    let out = "";
    for (let i = 0; i < end; i += 1) {
      out += bytes[i].toString(16).padStart(2, "0");
      if (i !== end - 1) out += " ";
    }
    return bytes.length > maxBytes ? `${out} …` : out;
  }

  function viewsOf(bytes) {
    const limit = Math.min(bytes.length, CONFIG.viewBytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const collect = (size, count, read) => {
      const values = [];
      for (let offset = 0; offset + size <= limit && values.length < count; offset += size) {
        const value = read(offset);
        values.push(Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : null);
      }
      return values;
    };
    return {
      endian: "little",
      i8: collect(1, 64, (offset) => view.getInt8(offset)),
      i16: collect(2, 32, (offset) => view.getInt16(offset, true)),
      i32: collect(4, 16, (offset) => view.getInt32(offset, true)),
      f32: collect(4, 16, (offset) => view.getFloat32(offset, true)),
      f64: collect(8, 8, (offset) => view.getFloat64(offset, true)),
    };
  }

  function enqueue(event) {
    if (!enabled) return;
    queue.push(event);
    while (queue.length > CONFIG.maxQueueEvents) {
      queue.shift();
      dropped += 1;
    }
    scheduleFlush();
  }

  function scheduleFlush(delay = CONFIG.flushIntervalMs) {
    if (flushTimer !== null || !enabled) return;
    flushTimer = page.setTimeout(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  function buildFrameEvent(direction, id, ts, agentTs, kind, bytes, socketUrl) {
    const truncated = bytes.length > CONFIG.maxFrameBytes;
    const payload = truncated ? bytes.subarray(0, CONFIG.maxFrameBytes) : bytes;
    if (direction === "in") framesIn += 1;
    else framesOut += 1;
    return {
      type: "frame",
      sid,
      seq: id,
      ts,
      agentTs,
      dir: direction,
      kind,
      len: bytes.length,
      truncated,
      b64: toBase64(payload),
      hex: hexOf(payload, CONFIG.hexBytes),
      views: viewsOf(payload),
      url: socketUrl || pageUrl,
    };
  }

  function recordBytes(direction, id, ts, agentTs, kind, bytes, socketUrl) {
    if (!enabled) return;
    // Keep the game's hot path cheap: copy the payload now, serialize later.
    pending.push({ direction, id, ts, agentTs, kind, bytes, socketUrl });
    while (pending.length > CONFIG.maxQueueEvents) {
      pending.shift();
      dropped += 1;
    }
    scheduleFlush();
  }

  function materializePending() {
    if (pending.length === 0) return;
    const items = pending;
    pending = [];
    for (const item of items) {
      queue.push(
        buildFrameEvent(item.direction, item.id, item.ts, item.agentTs, item.kind, item.bytes, item.socketUrl),
      );
    }
    while (queue.length > CONFIG.maxQueueEvents) {
      queue.shift();
      dropped += 1;
    }
  }

  function recordFrame(direction, data, socketUrl) {
    if (!enabled) return;
    const ts = Date.now();
    const agentTs = perfNow();
    const id = ++seq;

    if (typeof data === "string") {
      recordBytes(direction, id, ts, agentTs, "text", encoder.encode(data), socketUrl);
      return;
    }

    const tag = Object.prototype.toString.call(data);
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
      recordBytes(direction, id, ts, agentTs, "binary", new Uint8Array(data).slice(), socketUrl);
      return;
    }

    if (data !== null && typeof data === "object" && typeof data.byteLength === "number" && data.buffer !== undefined) {
      recordBytes(
        direction,
        id,
        ts,
        agentTs,
        "binary",
        new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength).slice(),
        socketUrl,
      );
      return;
    }

    if (data !== null && typeof data === "object" && typeof data.arrayBuffer === "function") {
      Promise.resolve(data.arrayBuffer())
        .then((buffer) =>
          recordBytes(direction, id, ts, agentTs, "binary", new Uint8Array(buffer).slice(), socketUrl),
        )
        .catch((error) => warn("blob read", error));
      return;
    }

    warn("unsupported frame payload", tag);
  }

  function connect() {
    if (!enabled || socket !== null) return;
    let candidate;
    try {
      candidate = new Native(wsUrl);
    } catch (error) {
      warn("connect", error);
      scheduleReconnect();
      return;
    }
    candidate.__devastTapInternal = true;
    socket = candidate;
    socketState = "connecting";
    candidate.onopen = () => {
      socketState = "open";
      try {
        candidate.send(
          JSON.stringify({
            type: "hello",
            sid,
            ts: Date.now(),
            url: pageUrl,
            userAgent: String(page.navigator?.userAgent ?? ""),
            binaryType: "mixed",
          }),
        );
      } catch (error) {
        warn("hello", error);
      }
      flush();
    };
    candidate.onclose = () => {
      socketState = "closed";
      socket = null;
      scheduleReconnect();
    };
    candidate.onerror = () => {
      socketState = "error";
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null || !enabled) return;
    reconnectTimer = page.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, CONFIG.reconnectMs);
  }

  function sendBody(body) {
    if (socket === null || socketState !== "open") return false;
    if (socket.bufferedAmount > CONFIG.wsBufferedLimit) return false;
    try {
      socket.send(body);
      return true;
    } catch (error) {
      warn("socket send", error);
      return false;
    }
  }

  function postBatch(batch, body) {
    if (!httpEnabled || httpInFlight) return false;
    lastHttpAttempt = Date.now();
    httpInFlight = true;
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: httpUrl,
        headers: {
          "content-type": "application/json",
          ...(token.length > 0 ? { "x-devast-token": token } : {}),
        },
        data: body,
        onload: (response) => {
          httpInFlight = false;
          if (response.status < 200 || response.status >= 300) {
            requeue(batch);
            console.warn(`[devast-tap] http ingest status ${response.status}`);
          }
        },
        onerror: () => {
          httpInFlight = false;
          requeue(batch);
        },
      });
      return true;
    } catch (error) {
      warn("http ingest", error);
      httpInFlight = false;
      httpEnabled = false;
      return false;
    }
  }

  function requeue(batch) {
    queue = [...batch, ...queue];
    while (queue.length > CONFIG.maxQueueEvents) {
      queue.shift();
      dropped += 1;
    }
  }

  function takeBatch() {
    const batch = queue.splice(0, Math.min(queue.length, CONFIG.maxBatchEvents));
    let body = JSON.stringify({ type: "batch", sid, events: batch });
    while (body.length > CONFIG.maxBatchChars && batch.length > 1) {
      const last = batch.pop();
      if (last !== undefined) queue.unshift(last);
      body = JSON.stringify({ type: "batch", sid, events: batch });
    }
    return { batch, body };
  }

  function flush() {
    materializePending();
    if (!enabled || queue.length === 0) return;
    if (socketState === "open") {
      let guard = 0;
      while (queue.length > 0 && guard < 20) {
        const { batch, body } = takeBatch();
        if (!sendBody(body)) {
          requeue(batch);
          break;
        }
        guard += 1;
      }
    } else if (httpEnabled && !httpInFlight && Date.now() - lastHttpAttempt > 1000) {
      const { batch, body } = takeBatch();
      if (!postBatch(batch, body)) requeue(batch);
    }
    if (queue.length > 0) scheduleFlush();
  }

  function pushAction(type, action) {
    if (!enabled) return;
    enqueue({
      type: "action",
      sid,
      ts: Date.now(),
      agentTs: perfNow(),
      action: { type, ...action },
    });
  }

  function mark(label) {
    if (!enabled) return;
    enqueue({
      type: "mark",
      sid,
      ts: Date.now(),
      agentTs: perfNow(),
      label: String(label).slice(0, 200),
    });
    scheduleFlush(50);
  }

  function instrument(ws, socketUrl) {
    if (ws === null || typeof ws !== "object" || ws.__devastTapInternal) return;
    if (instrumented.has(ws)) return;
    instrumented.add(ws);
    try {
      originalAddListener.call(ws, "message", (event) => {
        try {
          recordFrame("in", event.data, socketUrl ?? ws.url);
        } catch (error) {
          warn("record in", error);
        }
      });
    } catch (error) {
      warn("instrument", error);
    }
  }

  // WebSocket.prototype.send is patched once. The native send receives the
  // original arguments; the tap only observes the result. Local tap traffic is
  // marked internal and skipped, so the sniffer cannot record itself.
  try {
    Native.prototype.send = function tappedSend(data) {
      const result = originalSend.apply(this, arguments);
      if (!this.__devastTapInternal) {
        try {
          recordFrame("out", data, this.url);
        } catch (error) {
          warn("record out", error);
        }
      }
      return result;
    };
  } catch (error) {
    warn("patch send", error);
  }

  try {
    Native.prototype.addEventListener = function tappedAddEventListener(type, listener, options) {
      if (type === "message" && !this.__devastTapInternal) instrument(this);
      return originalAddListener.call(this, type, listener, options);
    };
  } catch (error) {
    warn("patch addEventListener", error);
  }

  if (originalOnMessage !== undefined && typeof originalOnMessage.set === "function") {
    try {
      Object.defineProperty(Native.prototype, "onmessage", {
        configurable: true,
        enumerable: originalOnMessage.enumerable,
        get() {
          return originalOnMessage.get === undefined ? undefined : originalOnMessage.get.call(this);
        },
        set(handler) {
          if (!this.__devastTapInternal) instrument(this);
          return originalOnMessage.set.call(this, handler);
        },
      });
    } catch (error) {
      warn("patch onmessage", error);
    }
  }

  function TapWebSocket(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    try {
      instrument(ws, String(url));
    } catch (error) {
      warn("tap constructor", error);
    }
    return ws;
  }

  try {
    TapWebSocket.prototype = Native.prototype;
  } catch (error) {
    warn("prototype", error);
  }
  try {
    Object.setPrototypeOf(TapWebSocket, Native);
  } catch (error) {
    warn("statics", error);
  }
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    try {
      TapWebSocket[key] = Native[key];
    } catch {
      // Non-writable WebSocket statics: the game still reads them from Native.
    }
  }
  try {
    Object.defineProperty(TapWebSocket, "name", { value: "WebSocket" });
  } catch {
    // Cosmetic only.
  }

  const disabledByFlag = (() => {
    try {
      return page.localStorage?.getItem("__devastTapOff") === "1";
    } catch {
      return false;
    }
  })();

  if (!disabledByFlag) {
    page.WebSocket = TapWebSocket;
  } else {
    enabled = false;
  }

  const attach = (type, handler, options) => {
    try {
      page.addEventListener(type, handler, options);
    } catch (error) {
      warn(`listener ${type}`, error);
    }
  };

  attach(
    "keydown",
    (event) => {
      if (event.repeat) return;
      pushAction("keydown", {
        key: String(event.key ?? "").slice(0, 16),
        code: String(event.code ?? "").slice(0, 24),
        ctrl: Boolean(event.ctrlKey),
        shift: Boolean(event.shiftKey),
        alt: Boolean(event.altKey),
        meta: Boolean(event.metaKey),
      });
    },
    true,
  );

  for (const type of ["mousedown", "mouseup"]) {
    attach(
      type,
      (event) => {
        pushAction(type, {
          button: event.button,
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          target: String(event.target?.tagName ?? "").slice(0, 16),
        });
      },
      true,
    );
  }

  let lastWheel = 0;
  attach(
    "wheel",
    (event) => {
      const now = Date.now();
      if (now - lastWheel < 100) return;
      lastWheel = now;
      pushAction("wheel", {
        deltaY: Math.sign(event.deltaY),
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      });
    },
    { capture: true, passive: true },
  );

  page.__devastTap = {
    sessionId: sid,
    mark,
    flush,
    stats: () => ({
      sessionId: sid,
      enabled,
      transport: socketState,
      queue: queue.length + pending.length,
      dropped,
      framesIn,
      framesOut,
      seq,
    }),
    enable: () => {
      enabled = true;
      connect();
      scheduleFlush(0);
    },
    disable: () => {
      enabled = false;
      queue = [];
      pending = [];
    },
  };

  if (enabled) {
    connect();
    console.info(`[devast-tap] installed, session ${sid}, ingest ${CONFIG.ingestUrl}`);
    console.info("[devast-tap] mark actions with: __devastTap.mark('axe-on-tree')");
    page.setInterval(() => {
      if (!enabled) return;
      const stats = page.__devastTap.stats();
      console.info(
        `[devast-tap] in=${stats.framesIn} out=${stats.framesOut} queue=${stats.queue} dropped=${stats.dropped} transport=${stats.transport}`,
      );
    }, 60_000);
  } else {
    console.info("[devast-tap] disabled by localStorage.__devastTapOff");
  }
})();
