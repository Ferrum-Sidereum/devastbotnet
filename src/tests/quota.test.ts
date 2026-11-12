import assert from "node:assert/strict";
import test from "node:test";
import { QuotaManager } from "../world/quota.js";

function manager(): QuotaManager {
  const quotas = new QuotaManager();
  quotas.createQuota({ id: "q1", resource: "wood", target: 3, dropOff: { kind: "operator" }, now: 1000 });
  quotas.assignBot("q1", "b1", 1000);
  quotas.assignBot("q1", "b2", 1000);
  return quotas;
}

test("reservation is exclusive per node", () => {
  const quotas = manager();
  assert.equal(quotas.tryReserve("q1", "b1", "n1").ok, true);
  assert.deepEqual(quotas.tryReserve("q1", "b2", "n1"), { ok: false, reason: "node-taken" });
  assert.equal(quotas.tryReserve("q1", "b1", "n1").ok, true, "same bot may re-reserve");
});

test("over-target is rejected", () => {
  const quotas = manager();
  assert.equal(quotas.tryReserve("q1", "b1", "n1").ok, true);
  assert.equal(quotas.tryReserve("q1", "b1", "n2").ok, true);
  assert.equal(quotas.tryReserve("q1", "b1", "n3").ok, true);
  assert.deepEqual(quotas.tryReserve("q1", "b2", "n4"), { ok: false, reason: "over-target" });
});

test("release frees the node and the reservation slot", () => {
  const quotas = manager();
  quotas.tryReserve("q1", "b1", "n1");
  quotas.tryReserve("q1", "b2", "n1");
  quotas.release("q1", "b1", "n1");
  assert.equal(quotas.tryReserve("q1", "b2", "n1").ok, true);
});

test("carried and delivered update in-flight and fulfill the quota", () => {
  const quotas = manager();
  quotas.onCarriedChanged("q1", "b1", { wood: 2 });
  let snapshot = quotas.snapshot().get("q1")!;
  assert.equal(snapshot.inFlight, 2);
  quotas.recordDelivery("q1", 2, 2000);
  snapshot = quotas.snapshot().get("q1")!;
  assert.equal(snapshot.delivered, 2);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.status, "active");
  quotas.recordDelivery("q1", 1, 3000);
  snapshot = quotas.snapshot().get("q1")!;
  assert.equal(snapshot.status, "fulfilled");
  assert.equal(snapshot.reservedNodes.size, 0);
});

test("unassigned bot and inactive quota are rejected", () => {
  const quotas = manager();
  assert.deepEqual(quotas.tryReserve("q1", "b3", "n1"), { ok: false, reason: "bot-unassigned" });
  quotas.cancel("q1", 4000);
  assert.deepEqual(quotas.tryReserve("q1", "b1", "n1"), { ok: false, reason: "quota-inactive" });
});
