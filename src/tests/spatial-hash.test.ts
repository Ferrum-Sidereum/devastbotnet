import assert from "node:assert/strict";
import test from "node:test";
import { SpatialHashGrid, type CircleBody } from "../world/spatial-hash.js";

const cellSize = 100;

function body(id: number, x: number, z: number, kind: CircleBody["kind"] = "whitelist", radius = 1): CircleBody {
  return { id, pos: { x, z }, radius, kind };
}

test("ally standing on the line of fire blocks the shot", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 50, 0));
  const hit = grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 });
  assert.equal(hit?.id, 1);
});

test("ally behind the impact point does not block", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 150, 0));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }), null);
});

test("neutral and blacklist bodies never block friendly fire", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 50, 0, "neutral"));
  grid.upsert(body(2, 60, 0, "blacklist"));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }), null);
  assert.equal(grid.querySegment({ x: 0, z: 0 }, { x: 100, z: 0 }).length, 2);
});

test("padding expands the hit corridor", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 50, 10));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }, 0), null);
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }, 8), null);
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }, 10)?.id, 1);
});

test("nearest blocker wins", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 80, 0));
  grid.upsert(body(2, 20, 0));
  grid.upsert(body(3, 50, 0));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 })?.id, 2);
});

test("upsert moves a body between cells and remove clears it", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 50, 0));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 })?.id, 1);

  grid.upsert(body(1, 50, 80));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }), null);

  grid.upsert(body(1, 50, 0));
  grid.remove(1);
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }), null);
  grid.remove(999);
});

test("negative coordinates and cell boundaries are handled", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, -25, 0));
  grid.upsert(body(2, 100, 0));
  assert.equal(grid.firstBlockingAlly({ x: -50, z: 0 }, { x: 50, z: 0 })?.id, 1);
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 200, z: 0 })?.id, 2);
});

test("tangent hit counts, just outside does not", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 50, 5, "whitelist", 5));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 })?.id, 1);

  grid.upsert(body(1, 50, 5.0001, "whitelist", 5));
  assert.equal(grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 100, z: 0 }), null);
});

test("zero-length segment checks the point itself", () => {
  const grid = new SpatialHashGrid(cellSize);
  grid.upsert(body(1, 10, 10));
  assert.equal(grid.firstBlockingAlly({ x: 10, z: 10 }, { x: 10, z: 10 })?.id, 1);
  assert.equal(grid.firstBlockingAlly({ x: 30, z: 30 }, { x: 30, z: 30 }), null);
});

test("invalid cell size and padding are rejected", () => {
  assert.throws(() => new SpatialHashGrid(0), RangeError);
  assert.throws(() => new SpatialHashGrid(Number.NaN), RangeError);
  const grid = new SpatialHashGrid(cellSize);
  assert.throws(() => grid.firstBlockingAlly({ x: 0, z: 0 }, { x: 1, z: 0 }, -1), RangeError);
});
