import type { Vec2 } from "./types.js";

/**
 * Ballistic intercept with network latency (Architecture v2, ADR-004).
 *
 * Solves |(T + V * (t_f + R)) - P| = s * t_f for the smallest positive t_f:
 *
 *   A = T + V*R - P
 *   (V·V - s²) t² + 2 (A·V) t + A·A = 0
 *
 * R = rtt/2 + tick/2 is the one-way latency plus half-tick quantization.
 */
export interface BallisticsInput {
  shooterPos: Vec2;
  /** Optional own velocity; included as P' = P + V_bot * R. */
  shooterVel?: Vec2;
  /** Target position extrapolated to decision time, not raw last-seen. */
  targetPos: Vec2;
  targetVel: Vec2;
  /** World units per second. */
  projectileSpeed: number;
  rttMs: number;
  serverTickMs: number;
  maxFlightTimeS?: number;
}

export type InterceptFailureReason =
  | "invalid-input"
  | "no-solution"
  | "target-outruns-projectile"
  | "out-of-range"
  | "numerical-degenerate";

export interface InterceptSolution {
  feasible: boolean;
  reason: InterceptFailureReason | null;
  /** Projectile travel time in seconds. */
  flightTimeS: number;
  /** One-way latency + half-tick, seconds. */
  latencyS: number;
  /** flightTimeS + latencyS: when the aim point is reached. */
  leadTimeS: number;
  aimPoint: Vec2 | null;
  /** Shooter position at shot time: P + V_bot * latency. NaN when infeasible. */
  shooterAtShot: Vec2;
  /** |aimPoint - shooterAtShot| in world units. */
  distance: number;
  discriminant: number;
  /** |distance - speed*flightTime|; proves the root satisfies the equation. */
  residual: number;
}

const GEOMETRY_EPS = 1e-9;

function infeasible(
  reason: InterceptFailureReason,
  latencyS = 0,
  discriminant = 0,
): InterceptSolution {
  return {
    feasible: false,
    reason,
    flightTimeS: 0,
    latencyS,
    leadTimeS: 0,
    aimPoint: null,
    shooterAtShot: { x: Number.NaN, z: Number.NaN },
    distance: 0,
    discriminant,
    residual: 0,
  };
}

export function solveIntercept(input: BallisticsInput): InterceptSolution {
  const {
    shooterPos,
    shooterVel,
    targetPos,
    targetVel,
    projectileSpeed: speed,
    rttMs,
    serverTickMs,
    maxFlightTimeS,
  } = input;

  if (
    !Number.isFinite(shooterPos.x) ||
    !Number.isFinite(shooterPos.z) ||
    !Number.isFinite(targetPos.x) ||
    !Number.isFinite(targetPos.z) ||
    !Number.isFinite(targetVel.x) ||
    !Number.isFinite(targetVel.z) ||
    (shooterVel !== undefined && (!Number.isFinite(shooterVel.x) || !Number.isFinite(shooterVel.z))) ||
    !Number.isFinite(speed) ||
    speed <= 0 ||
    !Number.isFinite(rttMs) ||
    rttMs < 0 ||
    !Number.isFinite(serverTickMs) ||
    serverTickMs < 0
  ) {
    return infeasible("invalid-input");
  }

  const latencyS = rttMs / 2000 + serverTickMs / 2000;
  const shooter: Vec2 = shooterVel
    ? {
        x: shooterPos.x + shooterVel.x * latencyS,
        z: shooterPos.z + shooterVel.z * latencyS,
      }
    : shooterPos;

  const ax = targetPos.x + targetVel.x * latencyS - shooter.x;
  const az = targetPos.z + targetVel.z * latencyS - shooter.z;

  const a = targetVel.x * targetVel.x + targetVel.z * targetVel.z - speed * speed;
  const b = 2 * (ax * targetVel.x + az * targetVel.z);
  const c = ax * ax + az * az;
  const aEps = 1e-8 * Math.max(1, speed * speed);
  const roots: number[] = [];
  let discriminant = 0;

  if (Math.abs(a) <= aEps) {
    // Equal speeds: b*t + c = 0. A non-negative b means the target never closes.
    if (Math.abs(b) <= GEOMETRY_EPS) {
      if (c <= GEOMETRY_EPS) {
        roots.push(0);
      } else {
        return infeasible("target-outruns-projectile", latencyS);
      }
    } else {
      const t = -c / b;
      if (t >= 0) roots.push(t);
    }
  } else {
    discriminant = b * b - 4 * a * c;
    if (discriminant < -GEOMETRY_EPS * Math.max(1, b * b, Math.abs(4 * a * c))) {
      return infeasible(
        a > 0 ? "target-outruns-projectile" : "no-solution",
        latencyS,
        discriminant,
      );
    }
    const sqrtD = Math.sqrt(Math.max(0, discriminant));
    const t1 = (-b - sqrtD) / (2 * a);
    const t2 = (-b + sqrtD) / (2 * a);
    if (t1 >= 0) roots.push(t1);
    if (t2 >= 0) roots.push(t2);
  }

  if (roots.length === 0) {
    return infeasible(
      a > 0 ? "target-outruns-projectile" : "no-solution",
      latencyS,
      discriminant,
    );
  }

  const flightTimeS = Math.min(...roots);
  if (maxFlightTimeS !== undefined && flightTimeS > maxFlightTimeS) {
    return infeasible("out-of-range", latencyS, discriminant);
  }

  const leadTimeS = flightTimeS + latencyS;
  const aimPoint: Vec2 = {
    x: targetPos.x + targetVel.x * leadTimeS,
    z: targetPos.z + targetVel.z * leadTimeS,
  };
  const dx = aimPoint.x - shooter.x;
  const dz = aimPoint.z - shooter.z;
  const distance = Math.hypot(dx, dz);
  const residual = Math.abs(distance - speed * flightTimeS);

  if (residual > 1e-6 * Math.max(1, distance)) {
    return {
      feasible: false,
      reason: "numerical-degenerate",
      flightTimeS,
      latencyS,
      leadTimeS,
      aimPoint,
      shooterAtShot: shooter,
      distance,
      discriminant,
      residual,
    };
  }

  return {
    feasible: true,
    reason: null,
    flightTimeS,
    latencyS,
    leadTimeS,
    aimPoint,
    shooterAtShot: shooter,
    distance,
    discriminant,
    residual,
  };
}
