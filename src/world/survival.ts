import type { StaminaMode } from "./stamina.js";

export type SurvivalAction =
  | "dead"
  | "eat"
  | "gather-food"
  | "warm-up"
  | "seek-heat"
  | "take-anti-rad"
  | "avoid-rad"
  | "retreat-home"
  | "none";

export interface SurvivalInput {
  hp: number;
  hunger: number;
  /** Body temperature; below coldThreshold requires warmth. */
  temperature: number;
  radiation: number;
  isNight: boolean;
  inRadZone: boolean;
  threat: "none" | "ghoul" | "player";
  hasFood: boolean;
  hasWarmClothes: boolean;
  hasHeatSource: boolean;
  hasAntiRad: boolean;
  hasRadProtection: boolean;
}

export interface SurvivalDecision {
  action: SurvivalAction;
  reason: string;
  priority: number;
  emergency: boolean;
  staminaMode: StaminaMode;
}

export const SURVIVAL_THRESHOLDS = {
  hunger: 35,
  cold: 30,
  radiation: 60,
} as const;

/**
 * Subsumption survival FSM (brief §5.1). Higher-priority needs preempt tasks.
 * The FSM returns an intent; movement/use-item packets are emitted by the bot
 * runtime, not here.
 */
export function decideSurvival(input: SurvivalInput): SurvivalDecision {
  if (input.hp <= 0) {
    return decision("dead", "hp is zero", 0, false);
  }
  if (input.threat !== "none") {
    return decision("retreat-home", `threat: ${input.threat}`, 1, true);
  }
  if (input.radiation >= SURVIVAL_THRESHOLDS.radiation) {
    if (input.hasAntiRad) return decision("take-anti-rad", "radiation above threshold", 2, false);
    if (!input.hasRadProtection && input.inRadZone) {
      return decision("avoid-rad", "radiation without protection", 2, false);
    }
  }
  if (input.hunger < SURVIVAL_THRESHOLDS.hunger) {
    if (input.hasFood) return decision("eat", "hunger below 35%", 3, false);
    return decision("gather-food", "hunger below 35% and no food", 3, false);
  }
  if (input.isNight || input.temperature < SURVIVAL_THRESHOLDS.cold) {
    if (input.hasWarmClothes) return decision("warm-up", "cold/night and warm clothes available", 4, false);
    if (input.hasHeatSource) return decision("seek-heat", "cold/night and heat source nearby", 4, false);
    return decision("retreat-home", "cold/night without clothing or heat", 4, true);
  }
  return decision("none", "no survival need", 9, false);
}

function decision(
  action: SurvivalAction,
  reason: string,
  priority: number,
  emergency: boolean,
): SurvivalDecision {
  return {
    action,
    reason,
    priority,
    emergency,
    staminaMode: emergency ? "emergency-retreat" : "routine",
  };
}

export type JobKind = "wood" | "stone" | "ironOre" | "sulfur" | "raid";
export type ToolKind = "axe" | "pickaxe" | "weapon" | "siege";

export interface Tool {
  id: string;
  kind: ToolKind;
  tier: number;
}

export function selectTool(
  job: JobKind,
  tools: readonly Tool[],
  enemyInRange: boolean,
): Tool | null {
  if (enemyInRange) return bestTool(tools, "weapon");
  if (job === "wood") return bestTool(tools, "axe");
  if (job === "stone" || job === "ironOre" || job === "sulfur") return bestTool(tools, "pickaxe");
  return bestTool(tools, "siege") ?? bestTool(tools, "weapon");
}

function bestTool(tools: readonly Tool[], kind: ToolKind): Tool | null {
  let best: Tool | null = null;
  for (const tool of tools) {
    if (tool.kind !== kind) continue;
    if (best === null || tool.tier > best.tier) best = tool;
  }
  return best;
}
