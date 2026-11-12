import assert from "node:assert/strict";
import test from "node:test";
import { solveIntercept, type BallisticsInput } from "../world/ballistics.js";

function baseInput(overrides: Partial<BallisticsInput> = {}): BallisticsInput {
  return {
    shooterPos: { x: 0, z: 0 },
    targetPos: { x: 100, z: 0 },
    targetVel: { x: 0, z: 0 },
    projectileSpeed: 100,
    rttMs: 0,
    serverTickMs: 0,
    ...overrides,
  };
}

function assertHitsTarget(input: BallisticsInput, tolerance = 1e-6): void {
  const solution = solveIntercept(input);
  assert.equal(solution.feasible, true, `expected feasible, got ${solution.reason}`);
  assert.ok(solution.aimPoint !== null);
  const dx = solution.aimPoint.x - input.shooterPos.x;
  const dz = solution.aimPoint.z - input.shooterPos.z;
  const distance = Math.hypot(dx, dz);
  assert.ok(
    Math.abs(distance - input.projectileSpeed * solution.flightTimeS) <= tolerance * Math.max(1, distance),
    `residual invariant failed: distance=${distance}, speed*t=${input.projectileSpeed * solution.flightTimeS}`,
  );
}

test("stationary target: flight time is distance over speed", () => {
  const solution = solveIntercept(baseInput());
  assert.equal(solution.feasible, true);
  assert.ok(Math.abs(solution.flightTimeS - 1) < 1e-9);
  assert.deepEqual(solution.aimPoint, { x: 100, z: 0 });
  assert.equal(solution.latencyS, 0);
});

test("perpendicular target requires lead", () => {
  const input = baseInput({ targetVel: { x: 0, z: 10 } });
  const solution = solveIntercept(input);
  assertHitsTarget(input);
  assert.ok(solution.aimPoint!.z > 9, `expected lead on z, got ${solution.aimPoint!.z}`);
});

test("receding slower target: positive root exists", () => {
  const input = baseInput({ targetVel: { x: 10, z: 0 } });
  const solution = solveIntercept(input);
  assertHitsTarget(input);
  assert.ok(solution.flightTimeS > 1, "receding target takes longer than the straight-line case");
});

test("target faster than projectile and fleeing: infeasible", () => {
  const solution = solveIntercept(
    baseInput({ targetPos: { x: 10, z: 0 }, targetVel: { x: 100, z: 0 }, projectileSpeed: 50 }),
  );
  assert.equal(solution.feasible, false);
  assert.equal(solution.reason, "target-outruns-projectile");
  assert.equal(solution.aimPoint, null);
});

test("equal speed, target closing: still interceptable", () => {
  const input = baseInput({ targetVel: { x: -50, z: 0 }, projectileSpeed: 50 });
  const solution = solveIntercept(input);
  assertHitsTarget(input);
  assert.ok(Math.abs(solution.flightTimeS - 1) < 1e-9, `got ${solution.flightTimeS}`);
});

test("equal speed, target fleeing: no solution", () => {
  const solution = solveIntercept(baseInput({ targetVel: { x: 50, z: 0 }, projectileSpeed: 50 }));
  assert.equal(solution.feasible, false);
  assert.equal(solution.reason, "no-solution");
});

test("RTT shifts the aim point forward by one-way latency", () => {
  const noLatency = solveIntercept(baseInput({ targetVel: { x: 10, z: 0 } }));
  const withLatency = solveIntercept(
    baseInput({ targetVel: { x: 10, z: 0 }, rttMs: 200, serverTickMs: 50 }),
  );
  assert.equal(withLatency.feasible, true);
  assert.ok(Math.abs(withLatency.latencyS - 0.125) < 1e-12);
  assert.ok(
    withLatency.aimPoint!.x > noLatency.aimPoint!.x,
    "latency must move the impact point further along the target velocity",
  );
});

test("shooter velocity is applied over the latency window", () => {
  const solution = solveIntercept(
    baseInput({ shooterVel: { x: 10, z: 0 }, targetVel: { x: 0, z: 0 }, rttMs: 100 }),
  );
  assert.equal(solution.feasible, true);
  // Shooter moved 0.5 units in 0.05 s, so the remaining distance is 99.5.
  assert.ok(Math.abs(solution.shooterAtShot.x - 0.5) < 1e-9);
  assert.ok(Math.abs(solution.aimPoint!.x - 100) < 1e-9);
  assert.ok(Math.abs(solution.flightTimeS - 0.995) < 1e-9);
});

test("max flight time rejects a distant target", () => {
  const solution = solveIntercept(baseInput({ maxFlightTimeS: 0.5 }));
  assert.equal(solution.feasible, false);
  assert.equal(solution.reason, "out-of-range");
  assert.ok(solution.latencyS === 0);
});

test("invalid input is rejected without throwing", () => {
  for (const projectileSpeed of [0, -1, Number.NaN]) {
    const solution = solveIntercept(baseInput({ projectileSpeed }));
    assert.equal(solution.feasible, false);
    assert.equal(solution.reason, "invalid-input");
  }
  const negativeRtt = solveIntercept(baseInput({ rttMs: -5 }));
  assert.equal(negativeRtt.reason, "invalid-input");
});
