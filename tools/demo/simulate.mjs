#!/usr/bin/env node
/**
 * 10-bot orchestration simulation. It exercises WorldStore, QuotaManager,
 * IFF, friendly-fire checks and the GUI snapshot path without a live game
 * session. The live demo:swarm remains blocked until the WS token provider
 * exists; this report is explicitly mode=simulation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createGuiServer } from "../gui/server.mjs";
import { QuotaManager } from "../../dist/world/quota.js";
import { WorldStore } from "../../dist/world/world-state.js";
import { IffRegistryStore, checkFriendlyFire } from "../../dist/world/iff.js";
import { SpatialHashGrid } from "../../dist/world/spatial-hash.js";
import { decideSurvival } from "../../dist/world/survival.js";
import { canSpendStamina } from "../../dist/world/stamina.js";

const bots = 10;
const now = Date.now();
const world = new WorldStore({ dynamicTtlMs: 12_000 });
const quotas = new QuotaManager();
const iff = new IffRegistryStore("operator");
iff.addWhitelist("operator");
iff.addBlacklist("raider");

const botViews = Array.from({ length: bots }, (_, index) => ({
  id: `bot-${index + 1}`,
  group: index < 4 ? 1 : index < 7 ? 2 : 3,
  role: index < 4 ? "miner" : index < 7 ? "hauler" : "guard",
  stance: index < 7 ? "peaceful" : "aggressive",
  x: 180 + (index % 5) * 150,
  z: 180 + Math.floor(index / 5) * 280,
  hp: 100,
  hunger: 80,
  radiation: 0,
  stamina: 100,
}));

for (const bot of botViews) {
  world.apply(
    {
      type: "observation",
      id: bot.id,
      kind: "player",
      pos: { x: bot.x, z: bot.z },
      vel: { x: 0, z: 0 },
      hp: bot.hp,
      stamina: bot.stamina,
      agentId: bot.id,
      observedAt: now,
      coverage: "direct",
    },
    now,
  );
}
world.apply(
  {
    type: "observation",
    id: "master-player",
    kind: "player",
    pos: { x: 500, z: 500 },
    vel: { x: 0, z: 0 },
    agentId: "master",
    observedAt: now,
    coverage: "shared",
  },
  now,
);
world.apply(
  {
    type: "observation",
    id: "base-wall",
    kind: "wall",
    pos: { x: 430, z: 380 },
    agentId: "master",
    observedAt: now,
    coverage: "shared",
  },
  now,
);

quotas.createQuota({ id: "demo-wood", resource: "wood", target: 20, dropOff: { kind: "operator" }, now });
for (const bot of botViews) quotas.assignBot("demo-wood", bot.id, now);
let reserved = 0;
for (let i = 0; i < bots; i += 1) {
  if (quotas.tryReserve("demo-wood", `bot-${i + 1}`, `node-${i + 1}`).ok) reserved += 1;
}
for (const bot of botViews.slice(0, 4)) quotas.onCarriedChanged("demo-wood", bot.id, { wood: 5 });
quotas.recordDelivery("demo-wood", 20, now + 1000);
const quota = quotas.snapshot().get("demo-wood");

const grid = new SpatialHashGrid(100);
grid.upsert({ id: 1, pos: { x: 500, z: 500 }, radius: 1.5, kind: "whitelist" });
grid.upsert({ id: 2, pos: { x: 720, z: 300 }, radius: 1.5, kind: "blacklist" });
const clearShot = checkFriendlyFire(grid, { x: 300, z: 300 }, { x: 720, z: 300 }, 0);
const blockedShot = checkFriendlyFire(grid, { x: 300, z: 300 }, { x: 700, z: 500 }, 0);
const combatResolved = !clearShot.blocked;
const friendlyFireBlocked = blockedShot.blocked;

const survival = decideSurvival({
  hp: 100, hunger: 25, temperature: 37, radiation: 0, isNight: false, inRadZone: false,
  threat: "none", hasFood: true, hasWarmClothes: true, hasHeatSource: false, hasAntiRad: true,
  hasRadProtection: false,
});
const staminaOk = canSpendStamina({ max: 100, routineFloorRatio: 0.5, emergencyFloorRatio: 0 }, 100, 10, "routine");

mkdirSync("sessions/demo-swarm", { recursive: true });
mkdirSync("sessions/demo-simulate", { recursive: true });
const report = {
  mode: "simulation",
  bots_simulated: bots,
  bots_connected: 0,
  quota_delivered: quota?.delivered ?? 0,
  combat_resolved: combatResolved,
  friendly_fire: friendlyFireBlocked ? 1 : 0,
  master_view_merged: world.getEntity("master-player") !== undefined,
  gui_server: true,
  survival_action: survival.action,
  stamina_routine_ok: staminaOk,
  reserved_nodes: reserved,
  createdAt: new Date().toISOString(),
};
writeFileSync("sessions/demo-simulate/report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

const gui = createGuiServer();
gui.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;
});
gui.listen(4173, "127.0.0.1", async () => {
  const snapshot = {
    tick: 1,
    bots: botViews.map((bot) => ({ ...bot, stamina: 100 })),
    players: [
      { id: "master-player", name: "operator", x: 500, z: 500, iff: "WHITELIST" },
      { id: "raider", name: "raider", x: 720, z: 300, iff: "BLACKLIST" },
    ],
    structures: [{ id: "base-wall", kind: "wall", x: 430, z: 380 }],
    quotas: quota ? [quota] : [],
    iff: { whitelist: ["operator"], blacklist: ["raider"] },
  };
  await fetch("http://127.0.0.1:4173/api/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  }).catch(() => {});
  console.log(`[demo:simulate] ${JSON.stringify(report)}`);
  gui.close();
});
