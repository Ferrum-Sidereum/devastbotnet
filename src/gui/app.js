const WORLD_SIZE = 1000;
const layers = { players: true, bots: true, structures: true };

const statusEl = document.getElementById("status");
const tickEl = document.getElementById("tick");
const markersEl = document.getElementById("markers");
const quotaEl = document.getElementById("quota-panel");
const groupsEl = document.getElementById("groups");
const iffEl = document.getElementById("iff");
const canvas = document.getElementById("map-canvas");
const ctx = canvas.getContext("2d");

let snapshot = null;

function pct(value) {
  return `${Math.max(0, Math.min(100, (value / WORLD_SIZE) * 100))}%`;
}

function marker(className, x, z, text, dataset) {
  const el = document.createElement("div");
  el.className = `marker ${className}`;
  el.style.left = pct(x);
  el.style.top = pct(z);
  el.textContent = text;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) el.dataset[key] = String(value);
  }
  return el;
}

function render() {
  if (snapshot === null) return;
  tickEl.textContent = String(snapshot.tick ?? 0);
  markersEl.replaceChildren();

  if (layers.structures) {
    for (const structure of snapshot.structures ?? []) {
      markersEl.append(
        marker("structure-marker", structure.x, structure.z, structure.kind, {
          layer: "structures",
          structureId: structure.id,
        }),
      );
    }
  }

  if (layers.players) {
    for (const player of snapshot.players ?? []) {
      markersEl.append(
        marker("player-marker " + String(player.iff ?? "neutral").toLowerCase(), player.x, player.z, player.name ?? player.id, {
          layer: "players",
          playerId: player.id,
          iff: player.iff ?? "NEUTRAL",
        }),
      );
    }
  }

  if (layers.bots) {
    for (const bot of snapshot.bots ?? []) {
      const el = marker("bot-marker group-" + String(bot.group ?? 1), bot.x, bot.z, String(bot.id).slice(-2), {
        layer: "bots",
        botId: bot.id,
        group: bot.group ?? 1,
        role: bot.role ?? "",
      });
      el.title = `${bot.id} · ${bot.role ?? ""} · HP ${bot.hp ?? "?"} · hunger ${bot.hunger ?? "?"} · rad ${bot.radiation ?? "?"} · stamina ${bot.stamina ?? "?"}`;
      markersEl.append(el);
    }
  }

  renderQuota();
  renderGroups();
  renderIff();
}

function renderQuota() {
  const quota = (snapshot.quotas ?? [])[0];
  if (!quota) {
    quotaEl.textContent = "нет активных квот";
    return;
  }
  const progress = Math.min(1, quota.delivered / Math.max(1, quota.target));
  quotaEl.replaceChildren();
  const title = document.createElement("div");
  title.className = "row";
  title.innerHTML = `<span>${quota.resource}</span><b>${quota.delivered}/${quota.target}</b>`;
  const bar = document.createElement("div");
  bar.className = "progress";
  const fill = document.createElement("i");
  fill.style.width = `${progress * 100}%`;
  bar.append(fill);
  const detail = document.createElement("div");
  detail.className = "muted";
  detail.textContent = `in flight ${quota.inFlight ?? 0} · ${quota.status}`;
  quotaEl.append(title, bar, detail);
}

function renderGroups() {
  const counts = new Map();
  for (const bot of snapshot.bots ?? []) {
    const group = String(bot.group ?? 1);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  groupsEl.replaceChildren();
  for (const [group, count] of [...counts].sort()) {
    const pill = document.createElement("span");
    pill.className = "group-pill";
    pill.dataset.group = group;
    pill.textContent = `G${group} · ${count}`;
    groupsEl.append(pill);
  }
  if (counts.size === 0) groupsEl.textContent = "нет ботов";
}

function renderIff() {
  const iff = snapshot.iff ?? { whitelist: [], blacklist: [] };
  iffEl.replaceChildren();
  for (const [label, list, color] of [
    ["whitelist", iff.whitelist ?? [], "var(--ally)"],
    ["blacklist", iff.blacklist ?? [], "var(--enemy)"],
  ]) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("span");
    value.style.color = color;
    value.textContent = list.length === 0 ? "—" : list.join(", ");
    row.append(name, value);
    iffEl.append(row);
  }
}

function drawMap() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#16232b";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 20; i += 1) {
    const x = (i / 20) * w;
    const y = (i / 20) * h;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#1c2c35";
  ctx.fillRect(w * 0.42, h * 0.38, w * 0.16, h * 0.2);
  ctx.fillStyle = "#23343d";
  ctx.fillRect(w * 0.18, h * 0.7, w * 0.12, h * 0.12);
  ctx.fillStyle = "#2b3b45";
  ctx.fillRect(w * 0.72, h * 0.16, w * 0.1, h * 0.1);
}

async function refresh() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    statusEl.textContent = `connected · ${snapshot.bots?.length ?? 0} bots · ${snapshot.players?.length ?? 0} players`;
    render();
  } catch (error) {
    statusEl.textContent = `offline: ${error.message}`;
  }
}

for (const checkbox of document.querySelectorAll("input[data-layer]")) {
  checkbox.addEventListener("change", () => {
    layers[checkbox.dataset.layer] = checkbox.checked;
    render();
  });
}

async function sendCommand(hex) {
  const status = document.getElementById("command-status");
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botIds: "all", hex, server: document.getElementById("server-select").value }),
    });
    const result = await response.json();
    status.textContent = result.ok ? `sent ${result.bytes} B to ${result.sent} bot(s)` : `error: ${result.error}`;
  } catch (error) {
    status.textContent = `offline: ${error.message}`;
  }
}

document.getElementById("send-command").addEventListener("click", () => {
  sendCommand(document.getElementById("command-hex").value.trim());
});
for (const button of document.querySelectorAll(".command-presets button")) {
  button.addEventListener("click", () => {
    document.getElementById("command-hex").value = button.dataset.hex;
    sendCommand(button.dataset.hex);
  });
}

drawMap();
refresh();
setInterval(refresh, 2000);

window.__GUI__ = {
  get snapshot() {
    return snapshot;
  },
  render,
  layers,
};
window.__GUI_READY__ = true;
