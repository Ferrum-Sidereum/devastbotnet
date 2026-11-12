import assert from "node:assert/strict";
import test from "node:test";
import { canSpendStamina, staminaFloor, type StaminaPolicy } from "../world/stamina.js";

const policy: StaminaPolicy = { max: 100, routineFloorRatio: 0.5, emergencyFloorRatio: 0 };

test("routine floor is half of max", () => {
  assert.equal(staminaFloor(policy, "routine"), 50);
  assert.equal(staminaFloor(policy, "emergency-retreat"), 0);
});

test("routine sprint stops at half, never below", () => {
  assert.equal(canSpendStamina(policy, 100, 50, "routine"), true);
  assert.equal(canSpendStamina(policy, 70, 20, "routine"), true);
  assert.equal(canSpendStamina(policy, 60, 20, "routine"), false);
  assert.equal(canSpendStamina(policy, 50, 1, "routine"), false);
});

test("emergency retreat may spend below half", () => {
  assert.equal(canSpendStamina(policy, 60, 40, "emergency-retreat"), true);
  assert.equal(canSpendStamina(policy, 20, 20, "emergency-retreat"), true);
  assert.equal(canSpendStamina(policy, 5, 10, "emergency-retreat"), false);
});

test("emergency floor is configurable", () => {
  const cautious: StaminaPolicy = { max: 100, routineFloorRatio: 0.5, emergencyFloorRatio: 0.1 };
  assert.equal(canSpendStamina(cautious, 20, 10, "emergency-retreat"), true);
  assert.equal(canSpendStamina(cautious, 15, 10, "emergency-retreat"), false);
});

test("invalid values are rejected", () => {
  assert.equal(canSpendStamina(policy, Number.NaN, 10, "routine"), false);
  assert.equal(canSpendStamina(policy, 100, -1, "routine"), false);
  assert.equal(canSpendStamina({ ...policy, max: 0 }, 0, 0, "routine"), false);
});
