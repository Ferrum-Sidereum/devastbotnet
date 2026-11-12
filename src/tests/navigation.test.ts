import assert from "node:assert/strict";
import test from "node:test";
import { ChunkedFlowGrid } from "../world/navigation.js";

test("flow points toward the target and blocked tiles have no flow", () => {
  const grid = new ChunkedFlowGrid({ width: 20, height: 20, chunkSize: 4, maxTilesPerTick: 1000 });
  grid.setTarget({ x: 0, z: 0 });
  const result = grid.rebuild();
  assert.equal(result.built, true);
  assert.deepEqual(grid.flowAt(10, 10), { x: -1, z: 0 });
  assert.equal(grid.flowAt(0, 0), null);
  grid.setBlocked(5, 5, true);
  const after = grid.rebuild();
  assert.equal(after.built, true);
  assert.equal(grid.flowAt(5, 5), null);
});

test("blocking a tile marks its chunk and neighbours dirty", () => {
  const grid = new ChunkedFlowGrid({ width: 16, height: 16, chunkSize: 4, maxTilesPerTick: 1000 });
  grid.setTarget({ x: 0, z: 0 });
  grid.rebuild();
  assert.equal(grid.dirtyCount, 0);
  grid.setBlocked(8, 8, true);
  assert.ok(grid.dirtyCount > 0);
  assert.equal(grid.isDirty(8, 8), true);
});

test("tile budget defers the rebuild", () => {
  const grid = new ChunkedFlowGrid({ width: 10, height: 10, chunkSize: 4, maxTilesPerTick: 10 });
  grid.setTarget({ x: 0, z: 0 });
  const deferred = grid.rebuild();
  assert.equal(deferred.built, false);
  assert.equal(grid.flowAt(5, 5), null);
  const full = new ChunkedFlowGrid({ width: 10, height: 10, chunkSize: 4, maxTilesPerTick: 200 });
  full.setTarget({ x: 0, z: 0 });
  assert.equal(full.rebuild().built, true);
  assert.equal(full.lastBuiltTileCount, 100);
});

test("unreachable target yields no flow", () => {
  const grid = new ChunkedFlowGrid({ width: 10, height: 10, chunkSize: 4, maxTilesPerTick: 1000 });
  grid.setBlocked(5, 5, true);
  grid.setTarget({ x: 5, z: 5 });
  grid.rebuild();
  assert.equal(grid.flowAt(0, 0), null);
});
