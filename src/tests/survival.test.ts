import assert from "node:assert/strict";
import test from "node:test";
import { decideSurvival, selectTool, type SurvivalInput, type Tool } from "../world/survival.js";

function input(overrides: Partial<SurvivalInput> = {}): SurvivalInput {
  return {
    hp: 100,
    hunger: 100,
    temperature: 37,
    radiation: 0,
    isNight: false,
    inRadZone: false,
    threat: "none",
    hasFood: true,
    hasWarmClothes: true,
    hasHeatSource: false,
    hasAntiRad: true,
    hasRadProtection: false,
    ...overrides,
  };
}

test("threat preempts every other need and requests emergency stamina", () => {
  const result = decideSurvival(input({ threat: "ghoul", hunger: 0 }));
  assert.equal(result.action, "retreat-home");
  assert.equal(result.emergency, true);
  assert.equal(result.staminaMode, "emergency-retreat");
});

test("hunger uses food or gathers it", () => {
  assert.equal(decideSurvival(input({ hunger: 20 })).action, "eat");
  assert.equal(decideSurvival(input({ hunger: 20, hasFood: false })).action, "gather-food");
  assert.equal(decideSurvival(input({ hunger: 35 })).action, "none");
});

test("radiation uses anti-rad, otherwise avoids the zone", () => {
  assert.equal(decideSurvival(input({ radiation: 80 })).action, "take-anti-rad");
  assert.equal(
    decideSurvival(input({ radiation: 80, hasAntiRad: false, inRadZone: true })).action,
    "avoid-rad",
  );
  assert.equal(
    decideSurvival(input({ radiation: 80, hasAntiRad: false, hasRadProtection: true })).action,
    "none",
  );
});

test("cold and night use clothes, heat, or retreat", () => {
  assert.equal(decideSurvival(input({ temperature: 10 })).action, "warm-up");
  assert.equal(
    decideSurvival(input({ temperature: 10, hasWarmClothes: false, hasHeatSource: true })).action,
    "seek-heat",
  );
  assert.equal(
    decideSurvival(input({ temperature: 10, hasWarmClothes: false })).action,
    "retreat-home",
  );
  assert.equal(decideSurvival(input({ isNight: true })).action, "warm-up");
});

test("dead overrides all needs", () => {
  assert.equal(decideSurvival(input({ hp: 0, threat: "ghoul" })).action, "dead");
});

test("tool selector picks the best tier for the job", () => {
  const tools: Tool[] = [
    { id: "axe1", kind: "axe", tier: 1 },
    { id: "axe2", kind: "axe", tier: 2 },
    { id: "pick1", kind: "pickaxe", tier: 1 },
    { id: "pick3", kind: "pickaxe", tier: 3 },
    { id: "gun", kind: "weapon", tier: 2 },
    { id: "ram", kind: "siege", tier: 1 },
  ];
  assert.equal(selectTool("wood", tools, false)?.id, "axe2");
  assert.equal(selectTool("stone", tools, false)?.id, "pick3");
  assert.equal(selectTool("ironOre", tools, false)?.id, "pick3");
  assert.equal(selectTool("raid", tools, false)?.id, "ram");
});

test("enemy in range forces the best weapon", () => {
  const tools: Tool[] = [
    { id: "axe", kind: "axe", tier: 3 },
    { id: "pistol", kind: "weapon", tier: 1 },
    { id: "rifle", kind: "weapon", tier: 3 },
  ];
  assert.equal(selectTool("wood", tools, true)?.id, "rifle");
  assert.equal(selectTool("wood", [], true), null);
});
