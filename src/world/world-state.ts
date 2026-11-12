import type {
  AgentId,
  BotId,
  BotRuntimeView,
  DynamicEntity,
  EntityConfidence,
  EntityId,
  EntityObservation,
  IffRegistry,
  IffRelation,
  SharedWorldState,
  StaticEntity,
  StaticKind,
  TaskQuota,
  TimestampMs,
  Vec2,
  WorldEntity,
  WorldInput,
  WorldWriter,
} from "./types.js";

const STATIC_KINDS: Record<string, true> = {
  wall: true,
  floor: true,
  door: true,
  spike: true,
  smelter: true,
  workbench: true,
  generator: true,
  storage: true,
  turret: true,
  robot: true,
  tesla: true,
  computer: true,
  campfire: true,
  other: true,
};

const EMPTY_IFF: IffRegistry = {
  resolve: (): IffRelation => "NEUTRAL",
  whitelistPlayers: new Set(),
  whitelistClans: new Set(),
  blacklistPlayers: new Set(),
  blacklistClans: new Set(),
  selfName: null,
  version: 0,
};

export interface WorldStoreOptions {
  /** Dynamic TTL in milliseconds; Architecture v2 range is 10_000–15_000. */
  dynamicTtlMs?: number;
  /** Conservative positional drift per second of staleness, world units. */
  driftSigmaPerSecond?: number;
  /** Base hitbox radius for LIVE entities. */
  hitboxRadius?: number;
  /** Negative ghost checks needed before a static entity is invalidated. */
  ghostConfirmations?: number;
}

interface DynamicBase {
  pos: Vec2;
  vel: Vec2;
  lastSeen: TimestampMs;
}

/**
 * Single-writer epistemic world store (Architecture v2, ADR-002/007).
 * It accepts observations and advances TTLs; no other code mutates entities.
 */
export class WorldStore implements WorldWriter {
  private readonly dynamicTtlMs: number;
  private readonly driftSigmaPerSecond: number;
  private readonly hitboxRadius: number;
  private readonly ghostConfirmations: number;
  private readonly entities = new Map<EntityId, WorldEntity>();
  private readonly dynamicBase = new Map<EntityId, DynamicBase>();
  private tick = 0;
  private snapshotTs = 0;

  constructor(options: WorldStoreOptions = {}) {
    this.dynamicTtlMs = options.dynamicTtlMs ?? 12_000;
    this.driftSigmaPerSecond = options.driftSigmaPerSecond ?? 1.5;
    this.hitboxRadius = options.hitboxRadius ?? 0.5;
    this.ghostConfirmations = options.ghostConfirmations ?? 2;
  }

  apply(event: WorldInput, now: TimestampMs): void {
    if (!isObservation(event)) return;
    const observation = event;
    const staticEntity = observation.isStatic ?? isStaticKind(observation.kind);
    if (staticEntity) this.applyStatic(observation, now);
    else this.applyDynamic(observation, now);
    this.snapshotTs = now;
  }

  advance(now: TimestampMs): void {
    this.tick += 1;
    this.snapshotTs = now;
    for (const entity of this.entities.values()) {
      if (isDynamic(entity)) {
        const base = this.dynamicBase.get(entity.id);
        if (base === undefined) continue;
        const staleness = Math.max(0, now - base.lastSeen);
        const speed = Math.hypot(base.vel.x, base.vel.z);
        const uncertainty =
          this.hitboxRadius + (speed * staleness) / 1000 + this.driftSigmaPerSecond * (staleness / 1000);
        const level: EntityConfidence["level"] =
          staleness >= this.dynamicTtlMs ? "LOST" : staleness === 0 ? "LIVE" : "STALE_DYNAMIC";
        const score =
          level === "LIVE" ? 1 : level === "LOST" ? 0 : Math.max(0, 1 - staleness / this.dynamicTtlMs);
        entity.pos = {
          x: base.pos.x + (base.vel.x * staleness) / 1000,
          z: base.pos.z + (base.vel.z * staleness) / 1000,
        };
        entity.confidence = {
          level,
          score,
          lastSeenTs: base.lastSeen,
          lastSeenBy: entity.confidence.lastSeenBy,
          stalenessMs: staleness,
          uncertaintyRadius: uncertainty,
          expiresAtTs: base.lastSeen + this.dynamicTtlMs,
        };
      } else {
        entity.confidence = {
          ...entity.confidence,
          level: entity.confidence.level === "LOST" ? "LOST" : "CACHED_STATIC",
          score: entity.confidence.level === "LOST" ? 0 : 1,
          stalenessMs: Math.max(0, now - entity.lastConfirmedTs),
        };
      }
    }
  }

  /**
   * Ghost-check: an agent covers a static entity's coordinate but the server
   * does not confirm it. Two covered negatives invalidate it; a positive
   * observation restores CACHED_STATIC.
   */
  markGhostCheck(
    entityId: EntityId,
    agentId: AgentId,
    covered: boolean,
    confirmed: boolean,
    now: TimestampMs,
  ): void {
    const entity = this.entities.get(entityId);
    if (entity === undefined || isDynamic(entity)) return;
    entity.ghostChecks = [
      ...entity.ghostChecks.slice(-9),
      { agentId, checkedAt: now, covered, confirmed },
    ];
    if (confirmed) {
      entity.lastConfirmedTs = now;
      entity.confidence = { ...entity.confidence, level: "CACHED_STATIC", score: 1, stalenessMs: 0 };
      return;
    }
    if (!covered) return;
    const negatives = entity.ghostChecks.filter((check) => check.covered && !check.confirmed).length;
    if (negatives >= this.ghostConfirmations) {
      entity.confidence = { ...entity.confidence, level: "LOST", score: 0 };
    }
  }

  snapshot(): SharedWorldState {
    let live = 0;
    let stale = 0;
    let cachedStatic = 0;
    let lost = 0;
    for (const entity of this.entities.values()) {
      switch (entity.confidence.level) {
        case "LIVE":
          live += 1;
          break;
        case "STALE_DYNAMIC":
          stale += 1;
          break;
        case "CACHED_STATIC":
          cachedStatic += 1;
          break;
        case "LOST":
          lost += 1;
          break;
      }
    }
    return {
      tick: this.tick,
      snapshotTs: this.snapshotTs,
      entities: new Map(this.entities),
      iff: EMPTY_IFF,
      quotas: new Map(),
      bots: new Map<BotId, BotRuntimeView>(),
      gridVersion: 0,
      stats: { live, stale, cachedStatic, lost, unknownFrames: 0 },
    };
  }

  getEntity(id: EntityId): WorldEntity | undefined {
    return this.entities.get(id);
  }

  private applyDynamic(observation: EntityObservation, now: TimestampMs): void {
    const existing = this.entities.get(observation.id);
    const observers =
      existing !== undefined && isDynamic(existing) && existing.confidence.level !== "LOST"
        ? new Set(existing.observers)
        : new Set<AgentId>();
    observers.add(observation.agentId);
    const confidence: EntityConfidence = {
      level: "LIVE",
      score: 1,
      lastSeenTs: now,
      lastSeenBy: observation.agentId,
      stalenessMs: 0,
      uncertaintyRadius: this.hitboxRadius,
      expiresAtTs: now + this.dynamicTtlMs,
    };
    this.entities.set(observation.id, {
      id: observation.id,
      kind: observation.kind as DynamicEntity["kind"],
      name: observation.name,
      clanTag: observation.clanTag,
      pos: { ...observation.pos },
      vel: { ...(observation.vel ?? { x: 0, z: 0 }) },
      hp: observation.hp,
      stamina: observation.stamina,
      confidence,
      observers: observers as Set<AgentId>,
      serverTsEstimate: observation.observedAt,
    });
    this.dynamicBase.set(observation.id, {
      pos: { ...observation.pos },
      vel: { ...(observation.vel ?? { x: 0, z: 0 }) },
      lastSeen: now,
    });
  }

  private applyStatic(observation: EntityObservation, now: TimestampMs): void {
    const existing = this.entities.get(observation.id);
    if (existing !== undefined && !isDynamic(existing)) {
      this.entities.set(observation.id, {
        ...existing,
        kind: observation.kind as StaticKind,
        pos: { ...observation.pos },
        bounds: observation.bounds,
        owner: observation.owner,
        hp: observation.hp,
        confidence: {
          level: "CACHED_STATIC",
          score: 1,
          lastSeenTs: now,
          lastSeenBy: observation.agentId,
          stalenessMs: 0,
          uncertaintyRadius: 0,
          expiresAtTs: null,
        },
        lastConfirmedTs: now,
      });
      return;
    }
    const staticEntity: StaticEntity = {
      id: observation.id,
      kind: observation.kind as StaticKind,
      pos: { ...observation.pos },
      bounds: observation.bounds,
      owner: observation.owner,
      hp: observation.hp,
      confidence: {
        level: "CACHED_STATIC",
        score: 1,
        lastSeenTs: now,
        lastSeenBy: observation.agentId,
        stalenessMs: 0,
        uncertaintyRadius: 0,
        expiresAtTs: null,
      },
      ghostChecks: [],
      firstSeenTs: now,
      lastConfirmedTs: now,
    };
    this.entities.set(observation.id, staticEntity);
  }
}

function isStaticKind(kind: string): kind is StaticKind {
  return kind in STATIC_KINDS;
}

function isDynamic(entity: WorldEntity): entity is DynamicEntity {
  return !(entity.kind in STATIC_KINDS);
}

function isObservation(event: WorldInput): event is EntityObservation {
  return (event as { type?: string }).type === "observation";
}
