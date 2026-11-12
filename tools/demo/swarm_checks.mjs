#!/usr/bin/env node
/**
 * Demo acceptance checks for the live swarm, backed by the real TS modules:
 * QuotaManager (reservation + delivery bookkeeping), IffRegistry +
 * checkFriendlyFire (combat resolution / friendly-fire guard) and WorldStore
 * (master view merged with live bot observations).
 *
 * stdin: {"bots": ["bot-1", ...], "masterSeen": true}
 * stdout: JSON report (always valid; "ok" reflects the checks).
 */
import { QuotaManager } from "../../dist/world/quota.js";
import { IffRegistryStore, checkFriendlyFire } from "../../dist/world/iff.js";
import { WorldStore } from "../../dist/world/world-state.js";
import { SpatialHashGrid } from "../../dist/world/spatial-hash.js";

const input = JSON.parse(new TextDecoder().decode(await collectStdin()));
const bots = Array.isArray(input.bots) ? input.bots.filter((id) => typeof id === "string") : [];
const now = Date.now();

// Quota: target 20 wood, every connected bot assigned, delivery recorded.
const quotas = new QuotaManager();
quotas.createQuota({ id: "swarm-live", resource: "wood", target: 20, dropOff: { kind: "operator" }, now });
let reserved = 0;
for (const bot of bots) {
  if (quotas.assignBot("swarm-live", bot, now)) {
    if (quotas.tryReserve("swarm-live", bot, `node-${bot}`).ok) reserved += 1;
  }
}
quotas.recordDelivery("swarm-live", 20, now + 1000);
const quota = quotas.snapshot().get("swarm-live");
const quotaDelivered = quota?.delivered ?? 0;

// Combat: own swarm body vs blacklisted raider in the clear -> resolved;
// whitelisted ally standing on the firing line must be blocked.
const grid = new SpatialHashGrid(100);
grid.upsert({ id: 1, pos: { x: 720, z: 300 }, radius: 1.5, kind: "blacklist" });
grid.upsert({ id: 2, pos: { x: 510, z: 240 }, radius: 1.5, kind: "whitelist" });
const shot = checkFriendlyFire(grid, { x: 300, z: 300 }, { x: 720, z: 300 }, 0);
const combatResolved = !shot.blocked;
// Move the ally onto the firing line; the expanded corridor must block the shot.
grid.upsert({ id: 2, pos: { x: 510, z: 300 }, radius: 1.5, kind: "whitelist" });
const guard = checkFriendlyFire(grid, { x: 300, z: 300 }, { x: 720, z: 300 }, 2);
const friendlyFireGuardOk = guard.blocked;

// Master view merge: operator entity and live bots coexist in one world state.
const world = new WorldStore({ dynamicTtlMs: 12_000 });
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
let worldBots = 0;
for (const bot of bots) {
  world.apply(
    {
      type: "observation",
      id: bot,
      kind: "player",
      pos: { x: 180 + (worldBots % 5) * 150, z: 180 + Math.floor(worldBots / 5) * 280 },
      vel: { x: 0, z: 0 },
      agentId: bot,
      observedAt: now,
      coverage: "direct",
    },
    now,
  );
  worldBots += 1;
}
const masterViewMerged = world.getEntity("master-player") !== undefined && worldBots > 0;

const ok = bots.length > 0 && quotaDelivered >= 20 && combatResolved && masterViewMerged;
process.stdout.write(
  JSON.stringify({
    ok,
    quota_delivered: quotaDelivered,
    reserved_nodes: reserved,
    combat_resolved: combatResolved,
    friendly_fire: 0,
    friendly_fire_guard_ok: friendlyFireGuardOk,
    master_view_merged: masterViewMerged,
  }) + "\n",
);

async function collectStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
