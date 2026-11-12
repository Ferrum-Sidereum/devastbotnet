#!/usr/bin/env node
/**
 * Captures a complete browser game bootstrap: the WS URL token plus the first
 * outbound join frame. Used to validate a Chrome-TLS headless transport.
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
await send("Network.enable");
let wsUrl = null;
let joinHex = null;
socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.method === "Network.webSocketWillSendHandshakeRequest" && message.params?.request?.url?.includes("devast.io")) {
    wsUrl = message.params.request.url;
  }
  if (message.method === "Network.webSocketCreated" && message.params?.url?.includes("devast.io")) {
    wsUrl = message.params.url;
  }
  if (message.method === "Network.requestWillBeSent" && message.params?.request?.url?.startsWith("wss://") && message.params.request.url.includes("devast.io")) {
    wsUrl = message.params.request.url;
  }
  if (message.method === "Network.webSocketFrameSent" && joinHex === null && message.params?.response?.payloadData) {
    const bytes = Buffer.from(message.params.response.payloadData, "base64");
    if (bytes.length > 20) joinHex = bytes.toString("hex");
  }
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
async function click(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
for (const [x, y] of [[640, 300], [640, 310], [640, 290], [640, 330]]) {
  await click(x, y);
  await new Promise((r) => setTimeout(r, 700));
  await send("Runtime.evaluate", { expression: `(() => { const b=[...document.querySelectorAll("button")].find(el=>/not now/i.test(el.textContent||"")); if(b)b.click(); })()`, returnByValue: true });
  await new Promise((r) => setTimeout(r, 300));
  await click(x, y);
  await new Promise((r) => setTimeout(r, 1500));
  if (wsUrl && joinHex) break;
}
if (!wsUrl || !joinHex) {
  console.error(JSON.stringify({ wsUrl: Boolean(wsUrl), join: Boolean(joinHex) }));
  socket.close();
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify({ wsUrl, joinHex, capturedAt: Date.now() }, null, 2));
console.log(JSON.stringify({ captured: true, host: new URL(wsUrl).host, joinBytes: joinHex.length / 2, file: outPath }));
socket.close();
