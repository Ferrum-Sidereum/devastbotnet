/**
 * World-state contracts (Architecture v2, ADR-002/005b/007).
 *
 * Read models are immutable. Mutations happen only through WorldWriter from
 * the single WorldTickLoop; see docs/ARCHITECTURE_V2.md invariant I1.
 */

import type { NetEvent } from "../protocol/types.js";
import type { StaminaMode } from "./stamina.js";

export type EntityId = number;
export type AgentId = string;
export type BotId = string;
export type QuotaId = string;
export type ResourceNodeId = string;
export type TimestampMs = number;

export interface Vec2 {
  x: number;
  z: number;
}

export type ConfidenceLevel = "LIVE" | "STALE_DYNAMIC" | "CACHED_STATIC" | "LOST";

export interface EntityConfidence {
  level: ConfidenceLevel;
  /** 1.0 for LIVE; linear decay to 0 over dynamicTtlMs for STALE_DYNAMIC. */
  score: number;
  lastSeenTs: TimestampMs;
  lastSeenBy: AgentId | null;
  stalenessMs: number;
  /** Bounding radius of positional uncertainty in world units. */
  uncertaintyRadius: number;
  /** Dynamic: moment of transition to LOST. Static: null (ghost-check only). */
  expiresAtTs: TimestampMs | null;
}

export interface ObservationSource {
  agentId: AgentId;
  frameSeq: number;
  observedAt: TimestampMs;
  /** `inferred` never authorizes a ghost-check. */
  coverage: "direct" | "shared" | "inferred";
}

export interface DynamicEntity {
  readonly id: EntityId;
  readonly kind: "player" | "mob" | "projectile" | "dropped-item";
  name?: string;
  clanTag?: string;
  pos: Vec2;
  vel: Vec2;
  hp?: number;
  /** Stamina when the server exposes it for observed players. */
  stamina?: number;
  equipped?: string;
  confidence: EntityConfidence;
  observers: ReadonlySet<AgentId>;
  serverTsEstimate: TimestampMs;
}

export type StaticKind =
  | "wall"
  | "floor"
  | "door"
  | "spike"
  | "smelter"
  | "workbench"
  | "generator"
  | "storage"
  | "turret"
  | "robot"
  | "tesla"
  | "computer"
  | "campfire"
  | "other";

export interface StaticEntity {
  readonly id: EntityId;
  readonly kind: StaticKind;
  pos: Vec2;
  bounds?: { min: Vec2; max: Vec2 };
  owner?: { name?: string; clanTag?: string };
  hp?: number;
  confidence: EntityConfidence;
  ghostChecks: ReadonlyArray<{
    agentId: AgentId;
    checkedAt: TimestampMs;
    covered: boolean;
    confirmed: boolean;
  }>;
  firstSeenTs: TimestampMs;
  lastConfirmedTs: TimestampMs;
}

export type WorldEntity = DynamicEntity | StaticEntity;

export type IffRelation = "SELF" | "WHITELIST" | "BLACKLIST" | "NEUTRAL";

export interface IffRegistry {
  resolve(name: string | undefined, clanTag?: string): IffRelation;
  readonly whitelistPlayers: ReadonlySet<string>;
  readonly whitelistClans: ReadonlySet<string>;
  readonly blacklistPlayers: ReadonlySet<string>;
  readonly blacklistClans: ReadonlySet<string>;
  /** Operator account; never targeted, never auto-attacked. */
  readonly selfName: string | null;
  readonly version: number;
}

export type BotStance = "peaceful" | "defensive" | "aggressive" | "chase" | "raid";

export interface BotRuntimeView {
  botId: BotId;
  groupId: string;
  role: "miner" | "hauler" | "crafter" | "guard" | "raider";
  stance: BotStance;
  link: "connected" | "reconnecting" | "lost";
  tier: 1 | 2;
  rttMs: number;
  pos: Vec2;
  hp: number;
  stamina: number;
  staminaMode: StaminaMode;
  hunger: number;
  radiation: number;
  temperature: number;
  inventory: Readonly<Partial<Record<ResourceKind, number>>>;
  currentQuotaId: QuotaId | null;
  weaponSwap: WeaponSwapState;
}

export type WeaponSwapPhase = "idle" | "swap-requested" | "swap-confirmed" | "fire-window";

export interface WeaponSwapState {
  phase: WeaponSwapPhase;
  requestedAtTs: TimestampMs;
  /** max(serverTickMs, rttMs) + safety margin. */
  deadlineTs: TimestampMs;
  targetId: EntityId | null;
  preAimPoint: Vec2 | null;
}

export interface WorldStats {
  live: number;
  stale: number;
  cachedStatic: number;
  lost: number;
  unknownFrames: number;
}

export interface SharedWorldState {
  readonly tick: number;
  readonly snapshotTs: TimestampMs;
  readonly entities: ReadonlyMap<EntityId, WorldEntity>;
  readonly iff: IffRegistry;
  readonly quotas: ReadonlyMap<QuotaId, TaskQuota>;
  readonly bots: ReadonlyMap<BotId, BotRuntimeView>;
  readonly gridVersion: number;
  readonly stats: WorldStats;
}

export interface OperatorCommand {
  readonly type: "set-stance" | "assign-quota" | "cancel-quota" | "mark-iff" | "move-group";
  readonly issuedAtTs: TimestampMs;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EntityObservation {
  type: "observation";
  id: EntityId;
  kind: DynamicEntity["kind"] | StaticKind;
  pos: Vec2;
  vel?: Vec2;
  hp?: number;
  stamina?: number;
  name?: string;
  clanTag?: string;
  owner?: { name?: string; clanTag?: string };
  bounds?: { min: Vec2; max: Vec2 };
  agentId: AgentId;
  observedAt: TimestampMs;
  coverage: ObservationSource["coverage"];
  /** Override kind classification when the raw kind is ambiguous. */
  isStatic?: boolean;
}

export type WorldInput = NetEvent | OperatorCommand | EntityObservation;

export interface WorldWriter {
  /** Single mutator; only the tick loop may call this. */
  apply(event: WorldInput, now: TimestampMs): void;
  advance(now: TimestampMs): void;
  snapshot(): SharedWorldState;
}

export type ResourceKind =
  | "wood"
  | "stone"
  | "ironOre"
  | "sulfur"
  | "metal"
  | "coal"
  | "electronicParts"
  | "wires"
  | "bigWires";

export type DropOffTarget =
  | { kind: "operator" }
  | { kind: "container"; entityId: EntityId }
  | { kind: "point"; pos: Vec2 };

export interface QuotaAssignment {
  botId: BotId;
  reservedNodeIds: ResourceNodeId[];
  phase: "to-node" | "gathering" | "hauling" | "smelting" | "crafting" | "blocked";
  carried: Partial<Record<ResourceKind, number>>;
  lastProgressTs: TimestampMs;
  blockedReason?: string;
}

export interface TaskQuota {
  id: QuotaId;
  resource: ResourceKind;
  target: number;
  /** Handed over at the drop-off point. */
  delivered: number;
  /** In bot inventories, not yet delivered. */
  inFlight: number;
  /** nodeId -> botId. Single source of truth for node contention. */
  reservedNodes: ReadonlyMap<ResourceNodeId, BotId>;
  assignments: ReadonlyMap<BotId, QuotaAssignment>;
  dropOff: DropOffTarget;
  status: "draft" | "active" | "fulfilled" | "cancelled" | "blocked";
  priority: number;
  /** 1.0 = no overproduction allowance. */
  overprovisionFactor: number;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
}

export type ReservationFailureReason =
  | "node-taken"
  | "quota-inactive"
  | "over-target"
  | "bot-unassigned"
  | "unknown-node"
  | "node-not-observed";

export interface ReservationResult {
  ok: boolean;
  reason?: ReservationFailureReason;
}

export interface QuotaEngine {
  /** Atomic within one tick: check + insert, no await. */
  tryReserve(quotaId: QuotaId, botId: BotId, nodeId: ResourceNodeId): ReservationResult;
  release(quotaId: QuotaId, botId: BotId, nodeId: ResourceNodeId): void;
  onCarriedChanged(quotaId: QuotaId, botId: BotId, carried: Partial<Record<ResourceKind, number>>): void;
}

export interface TickBudget {
  startedAtTs: TimestampMs;
  maxTickMs: number;
  usedMs: number;
  overrun: boolean;
}

export interface TickStats {
  tick: number;
  drainedEvents: number;
  droppedPositional: number;
  durationMs: number;
  overrun: boolean;
  navDeferredChunks: number;
}
