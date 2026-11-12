/**
 * Stamina spending policy (Architecture v2, §12.1).
 *
 * Routine movement must not drain stamina below half. The emergency-retreat
 * mode (running home from night/cold or ghouls) may spend below that floor,
 * down to a separately configured emergency floor.
 */
export type StaminaMode = "routine" | "emergency-retreat";

export interface StaminaPolicy {
  /** Maximum stamina for this bot. */
  max: number;
  /** Fraction of max kept during routine travel/gather/patrol. */
  routineFloorRatio: number;
  /** Fraction of max kept during an emergency retreat. 0 allows full spend. */
  emergencyFloorRatio: number;
}

export const DEFAULT_STAMINA_POLICY: StaminaPolicy = {
  max: 100,
  routineFloorRatio: 0.5,
  emergencyFloorRatio: 0,
};

export function staminaFloor(policy: StaminaPolicy, mode: StaminaMode): number {
  const ratio = mode === "routine" ? policy.routineFloorRatio : policy.emergencyFloorRatio;
  return policy.max * ratio;
}

export function canSpendStamina(
  policy: StaminaPolicy,
  current: number,
  cost: number,
  mode: StaminaMode,
): boolean {
  if (
    !Number.isFinite(policy.max) ||
    policy.max <= 0 ||
    !Number.isFinite(current) ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    current < 0
  ) {
    return false;
  }
  return current - cost >= staminaFloor(policy, mode);
}
