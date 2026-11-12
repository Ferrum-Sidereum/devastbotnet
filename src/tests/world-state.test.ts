import assert from "node:assert/strict";
import test from "node:test";
import { WorldStore } from "../world/world-state.js";
import type { DynamicEntity, EntityObservation, StaticEntity } from "../world/types.js";

function observeDynamic(
  id: number,
  pos: { x: number; z: number },
  vel: { x: number; z: number },
  agentId = "a1",
  now = 1000,
): EntityObservation {
  return {
    type: "observation",
    id,
    kind: "player",
    pos,
    vel,
    agentId,
    observedAt: now,
    coverage: "direct",
  };
}

function observeStatic(id: number, pos: { x: number; z: number }, agentId = "a1", now = 1000): EntityObservation {
  return {
    type: "observation",
    id,
    kind: "wall",
    pos,
    agentId,
    observedAt: now,
    coverage: "direct",
  };
}

test("dynamic entity decays LIVE -> STALE -> LOST and extrapolates", () => {
  const store = new WorldStore({ dynamicTtlMs: 10_000, driftSigmaPerSecond: 1, hitboxRadius: 0.5 });
  store.apply(observeDynamic(1, { x: 0, z: 0 }, { x: 10, z: 0 }), 1000);
  let entity = store.getEntity(1) as DynamicEntity;
  assert.equal(entity.confidence.level, "LIVE");
  assert.equal(entity.confidence.score, 1);

  store.advance(2000);
  entity = store.getEntity(1) as DynamicEntity;
  assert.equal(entity.confidence.level, "STALE_DYNAMIC");
  assert.ok(Math.abs(entity.confidence.score - 0.9) < 1e-9);
  assert.ok(Math.abs(entity.pos.x - 10) < 1e-9);
  assert.ok(entity.confidence.uncertaintyRadius > 10);

  store.advance(11_000);
  entity = store.getEntity(1) as DynamicEntity;
  assert.equal(entity.confidence.level, "LOST");
  assert.equal(entity.confidence.score, 0);
  assert.ok(Math.abs(entity.pos.x - 100) < 1e-9);
});

test("re-observation revives a LOST entity", () => {
  const store = new WorldStore({ dynamicTtlMs: 1000 });
  store.apply(observeDynamic(1, { x: 0, z: 0 }, { x: 0, z: 0 }), 1000);
  store.advance(3000);
  assert.equal(store.getEntity(1)?.confidence.level, "LOST");
  store.apply(observeDynamic(1, { x: 5, z: 5 }, { x: 0, z: 0 }, "a2", 4000), 4000);
  const entity = store.getEntity(1) as DynamicEntity;
  assert.equal(entity.confidence.level, "LIVE");
  assert.equal(entity.pos.x, 5);
  assert.deepEqual([...entity.observers], ["a2"]);
});

test("static entities do not expire and require two covered ghost checks", () => {
  const store = new WorldStore({ ghostConfirmations: 2 });
  store.apply(observeStatic(2, { x: 10, z: 10 }), 1000);
  store.advance(1_000_000);
  assert.equal(store.getEntity(2)?.confidence.level, "CACHED_STATIC");

  store.markGhostCheck(2, "a1", true, false, 2000);
  assert.equal(store.getEntity(2)?.confidence.level, "CACHED_STATIC");
  store.markGhostCheck(2, "a1", true, false, 3000);
  assert.equal(store.getEntity(2)?.confidence.level, "LOST");

  store.markGhostCheck(2, "a1", true, true, 4000);
  assert.equal(store.getEntity(2)?.confidence.level, "CACHED_STATIC");
});

test("uncovered ghost checks never invalidate", () => {
  const store = new WorldStore({ ghostConfirmations: 1 });
  store.apply(observeStatic(3, { x: 0, z: 0 }), 1000);
  for (let i = 0; i < 5; i += 1) store.markGhostCheck(3, "a1", false, false, 2000 + i);
  assert.equal(store.getEntity(3)?.confidence.level, "CACHED_STATIC");
});

test("observers are merged for a live entity", () => {
  const store = new WorldStore();
  store.apply(observeDynamic(1, { x: 0, z: 0 }, { x: 0, z: 0 }, "a1"), 1000);
  store.apply(observeDynamic(1, { x: 1, z: 0 }, { x: 0, z: 0 }, "a2"), 1100);
  const entity = store.getEntity(1) as DynamicEntity;
  assert.deepEqual([...entity.observers].sort(), ["a1", "a2"]);
  assert.equal(entity.pos.x, 1);
});

test("snapshot reports stats and static classification", () => {
  const store = new WorldStore({ dynamicTtlMs: 1000 });
  store.apply(observeDynamic(1, { x: 0, z: 0 }, { x: 0, z: 0 }), 1000);
  store.apply(observeStatic(2, { x: 0, z: 0 }), 1000);
  store.advance(2500);
  const snapshot = store.snapshot();
  assert.equal(snapshot.entities.size, 2);
  assert.equal(snapshot.stats.live, 0);
  assert.equal(snapshot.stats.stale, 0);
  assert.equal(snapshot.stats.cachedStatic, 1);
  assert.equal(snapshot.stats.lost, 1);
  assert.ok(snapshot.entities.get(2) as StaticEntity);
  assert.equal(snapshot.quotas.size, 0);
});
