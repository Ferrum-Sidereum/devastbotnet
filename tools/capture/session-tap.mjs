#!/usr/bin/env node
/**
 * Captures URL + first outbound frame (join) from the same browser session.
 * The tap passes traffic through; it only records the constructor URL and the
 * first few outbound payloads.
 */
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const port = Number(process.env.CDP_PORT ?? 9333);
const outPath = process.argv[2] ?? "C:/R/Temp/devast-session.json";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
const socket = new WebSocket(page.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${port}` });
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.id === undefined) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const Native = window.WebSocket;
    const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    window.__cap = { urls: [], sent: [] };
    function Tap(url, protocols) {
      window.__cap.urls.push(String(url));
      return protocols === undefined ? new Native(url) : new Native(url, protocols);
    }
    Tap.prototype = Native.prototype;
    Object.setPrototypeOf(Tap, Native);
    window.WebSocket = Tap;
    const nativeSend = Native.prototype.send;
    Native.prototype.send = function (data) {
      try {
        let bytes = null;
        if (typeof data === "string") bytes = new TextEncoder().encode(data);
        else if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") bytes = new Uint8Array(data);
        else if (data && data.buffer !== undefined) bytes = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        if (bytes && window.__cap.sent.length < 20) window.__cap.sent.push({ hex: hex(bytes), len: bytes.length, ts: Date.now(), url: String(this.url || "") });
      } catch {}
      return nativeSend.apply(this, arguments);
    };
  })();`,
});
await send("Page.navigate", { url: "https://devast.io/" });
let ready = false;
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const probe = await send("Runtime.evaluate", { expression: "Boolean(document.querySelector('#nicknameInput'))", returnByValue: true });
  if (probe.result.value === true) { ready = true; break; }
}
if (!ready) console.error("menu not ready");
await send("Runtime.evaluate", {
  expression: `(() => {
    const b = [...document.querySelectorAll("button")].find((el) => /not now/i.test(el.textContent || ""));
    if (b) b.click();
    const n = document.querySelector("#nicknameInput");
    if (n) { n.value = "capture42"; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); }
  })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 800));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("C:/R/Temp/devast-tap.png", Buffer.from(shot.data, "base64"));

async function click(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
for (const [x, y] of [[640, 300], [640, 310], [640, 290], [640, 330], [640, 350], [640, 270], [640, 380]]) {
  await click(x, y);
  await new Promise((r) => setTimeout(r, 600));
  await send("Runtime.evaluate", { expression: `(() => { const b=[...document.querySelectorAll("button")].find(el=>/not now/i.test(el.textContent||"")); if(b)b.click(); })()`, returnByValue: true });
  await new Promise((r) => setTimeout(r, 400));
  await click(x, y);
  await new Promise((r) => setTimeout(r, 1200));
  const probe = await send("Runtime.evaluate", { expression: "window.__cap ?? null", returnByValue: true });
  const cap = probe.result.value;
  if (cap && cap.urls.some((url) => url.includes("devast.io"))) {
    await new Promise((r) => setTimeout(r, 4000));
    const late = await send("Runtime.evaluate", { expression: "window.__cap ?? null", returnByValue: true });
    const wsUrl = cap.urls.find((url) => url.includes("devast.io"));
    const sent = late.result.value?.sent ?? cap.sent;
    const join = (sent.find((frame) => frame.len > 20) ?? sent[0])?.hex ?? "";
    writeFileSync(outPath, JSON.stringify({ wsUrl, joinHex: join, capturedAt: Date.now() }, null, 2));
    console.log(JSON.stringify({ captured: true, host: new URL(wsUrl).host, joinBytes: join.length / 2, sent: cap.sent.length, file: outPath }));
    socket.close();
    process.exit(0);
  }
}
const final = await send("Runtime.evaluate", { expression: "({ cap: window.__cap ?? null, body: document.body.innerText.slice(0,120) })", returnByValue: true });
console.error(JSON.stringify(final.result.value));
console.log(JSON.stringify({ captured: false }));
socket.close();
process.exit(1);
