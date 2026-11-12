import assert from "node:assert/strict";
import test from "node:test";
import { checkFriendlyFire, focusFireOffsets, IffRegistryStore } from "../world/iff.js";
import { SpatialHashGrid } from "../world/spatial-hash.js";

test("IFF resolves self, whitelist, blacklist and neutral", () => {
  const iff = new IffRegistryStore("operator");
  iff.addWhitelist("Friend");
  iff.addBlacklist("Enemy", "CLAN");
  assert.equal(iff.resolve("operator"), "SELF");
  assert.equal(iff.resolve("friend"), "WHITELIST");
  assert.equal(iff.resolve("nobody", "clan"), "BLACKLIST");
  assert.equal(iff.resolve("stranger"), "NEUTRAL");
  assert.equal(iff.resolve(undefined, "unknown"), "NEUTRAL");
});

test("IFF version increments on mutations", () => {
  const iff = new IffRegistryStore();
  const before = iff.version;
  iff.addWhitelist("a");
  iff.addBlacklist("b");
  maybeRemove(iff);
  assert.ok(iff.version > before);
});

function maybeRemove(iff: IffRegistryStore): void {
  iff.removeWhitelist("a");
}

test("friendly fire is blocked only by allies on the line", () => {
  const grid = new SpatialHashGrid(100);
  grid.upsert({ id: 1, pos: { x: 50, z: 0 }, radius: 1, kind: "whitelist" });
  const blocked = checkFriendlyFire(grid, { x: 0, z: 0 }, { x: 100, z: 0 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.blocker?.id, 1);

  grid.remove(1);
  grid.upsert({ id: 2, pos: { x: 50, z: 0 }, radius: 1, kind: "blacklist" });
  const clear = checkFriendlyFire(grid, { x: 0, z: 0 }, { x: 100, z: 0 });
  assert.equal(clear.blocked, false);
});

test("focus fire offsets are symmetric and unique", () => {
  assert.deepEqual(focusFireOffsets(1), [0]);
  assert.deepEqual(focusFireOffsets(4), [0, -0.2, 0.2, -0.4]);
  assert.equal(new Set(focusFireOffsets(6)).size, 6);
});
