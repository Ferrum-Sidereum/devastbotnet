#!/usr/bin/env node
/**
 * Deterministic token capture through a Chrome CDP endpoint.
 *
 * Injects a WebSocket constructor wrapper before the game bundle loads, opens
 * Devast.io, submits the nickname/Play action, and writes the first captured
 * wss:// URL. The wrapper throws before opening a socket, so the token is not
 * consumed by the browser.
 *
 * Multi-capture: `--ws <targetDebuggerUrl>` pins the session to one CDP target
 * (so several captures can run in parallel tabs) and `--count N` repeats the
 * capture loop, writing one JSON line per token: {"i", "url", "capturedAt"}.
 */
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const port = Number(process.env.CDP_PORT ?? 9333);
const outPath = argValue("--out") ?? args[0] ?? "C:/R/Temp/devast-ws-url.txt";
const pinnedTarget = argValue("--ws");
const count = Math.max(1, Number(argValue("--count") ?? 1));
const menuProbe = "Boolean(document.querySelector('#nicknameInput')) && document.body.innerText.includes('Auto Select')";

const target = pinnedTarget
  ? { webSocketDebuggerUrl: pinnedTarget }
  : (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("no page target with webSocketDebuggerUrl");

const socket = new WebSocket(target.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${port}` });
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
  if (entry === undefined) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const Native = window.WebSocket;
    window.__wsUrls = [];
    function Capture(url, protocols) {
      window.__wsUrls.push(String(url));
      throw new Error("ws captured");
    }
    Capture.prototype = Native.prototype;
    Object.setPrototypeOf(Capture, Native);
    window.WebSocket = Capture;
  })();`,
});

async function evaluate(expression) {
  const result = await Promise.race([
    send("Runtime.evaluate", { expression, returnByValue: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timeout")), 8000)),
  ]);
  return result.result?.value;
}

async function click(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// Per-token budget constants (bounded run; no unbounded ad waits).
const MENU_POLL_MS = 500;
const MENU_POLLS = 45;
const CLICK_ATTEMPTS = 5;
const CLICK_PAUSE_MS = 600;
const RETRY_PAUSE_MS = 1200;

let captured = 0;
const lines = [];
const legacy = count === 1 && pinnedTarget === undefined;
const NAV_ATTEMPTS = 2;
for (let i = 1; i <= count; i += 1) {
  try {
    let ready = false;
    for (let nav = 0; nav < NAV_ATTEMPTS && !ready; nav += 1) {
      await send("Page.navigate", { url: "https://devast.io/" });
      for (let poll = 0; poll < MENU_POLLS; poll += 1) {
        await new Promise((r) => setTimeout(r, MENU_POLL_MS));
        if ((await evaluate(menuProbe)) === true) {
          ready = true;
          break;
        }
      }
    }
    if (!ready) {
      let diag = "";
      try {
        diag = JSON.stringify(
          (await evaluate("({ href: location.href, text: document.body.innerText.slice(0, 160) })")) ?? {},
        );
      } catch {
        diag = "evaluate failed";
      }
      lines.push({ i, url: null, error: "menu not ready", diag });
      console.error(`token ${i}/${count}: menu not ready ${diag.slice(0, 160)}`);
      continue;
    }

  const requestedServer = process.env.DEVAST_SERVER?.trim();
  if (requestedServer) {
    await evaluate(`(() => {
      const select = document.querySelector("#servers");
      if (!select) return false;
      select.value = ${JSON.stringify(requestedServer)};
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value;
    })()`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((el) => /not now/i.test(el.textContent || ""));
    if (button) button.click();
    const nick = document.querySelector("#nicknameInput");
    if (nick) {
      nick.value = "capture42";
      nick.dispatchEvent(new Event("input", { bubbles: true }));
      nick.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);

  let url = null;
  for (const [x, y] of [[640, 300], [640, 310], [640, 290], [640, 330], [640, 270]]) {
    await click(x, y);
    await new Promise((r) => setTimeout(r, CLICK_PAUSE_MS));
    await evaluate(`(() => { const b=[...document.querySelectorAll("button")].find(el=>/not now/i.test(el.textContent||"")); if(b)b.click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
    await click(x, y);
    await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    const urls = (await evaluate("window.__wsUrls ?? []")) ?? [];
    if (urls.length > 0) {
      url = urls[urls.length - 1];
      break;
    }
  }

  if (url) {
    captured += 1;
    lines.push({ i, url, capturedAt: Date.now() });
    console.error(`token ${i}/${count}: captured`);
  } else {
    let diag = "";
    try {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (shot?.data) writeFileSync(`C:/R/Temp/devast-fail-${process.pid}-${i}.png`, Buffer.from(shot.data, "base64"));
      diag = JSON.stringify((await evaluate("({ href: location.href, text: document.body.innerText.slice(0, 220) })")) ?? {});
    } catch {
      diag = "evaluate failed";
    }
    lines.push({ i, url: null, error: "no ws url captured", diag });
    console.error(`token ${i}/${count}: FAILED ${diag.slice(0, 200)}`);
  }
  // Flush after every token: a killed process must not lose captured tokens.
  writeFileSync(outPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  } catch (error) {
    lines.push({ i, url: null, error: `crashed: ${String(error).slice(0, 140)}` });
    console.error(`token ${i}/${count}: crashed ${error}`);
  }
}

if (legacy) {
  const first = lines[0];
  if (!first?.url) {
    console.error(first?.error ?? "no url");
    console.log(JSON.stringify({ captured: false }));
    process.exit(1);
  }
  writeFileSync(outPath, first.url, "utf8");
  socket.close();
  console.log(JSON.stringify({ captured: true, length: first.url.length, file: outPath }));
  process.exit(0);
}

writeFileSync(outPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
socket.close();
console.log(JSON.stringify({ captured, requested: count, file: outPath }));
process.exit(captured === count ? 0 : 1);
