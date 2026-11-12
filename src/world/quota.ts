import type {
  BotId,
  QuotaAssignment,
  QuotaEngine,
  QuotaId,
  ReservationFailureReason,
  ReservationResult,
  ResourceKind,
  ResourceNodeId,
  TaskQuota,
  TimestampMs,
} from "./types.js";

interface MutableQuota extends Omit<TaskQuota, "reservedNodes" | "assignments"> {
  reservedNodes: Map<ResourceNodeId, BotId>;
  assignments: Map<BotId, QuotaAssignment>;
}

export interface CreateQuotaInput {
  id: QuotaId;
  resource: ResourceKind;
  target: number;
  dropOff: TaskQuota["dropOff"];
  overprovisionFactor?: number;
  priority?: number;
  now?: TimestampMs;
}

/**
 * Atomic quota engine (Architecture v2, ADR-005b). All methods are synchronous
 * and intended to run inside the single-writer tick loop.
 */
export class QuotaManager implements QuotaEngine {
  private readonly quotas = new Map<QuotaId, MutableQuota>();

  createQuota(input: CreateQuotaInput): TaskQuota {
    const now = input.now ?? Date.now();
    const quota: MutableQuota = {
      id: input.id,
      resource: input.resource,
      target: input.target,
      delivered: 0,
      inFlight: 0,
      reservedNodes: new Map(),
      assignments: new Map(),
      dropOff: input.dropOff,
      status: "active",
      priority: input.priority ?? 0,
      overprovisionFactor: input.overprovisionFactor ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.quotas.set(quota.id, quota);
    return this.clone(quota);
  }

  assignBot(quotaId: QuotaId, botId: BotId, now: TimestampMs = Date.now()): boolean {
    const quota = this.quotas.get(quotaId);
    if (quota === undefined || quota.status !== "active") return false;
    if (!quota.assignments.has(botId)) {
      quota.assignments.set(botId, {
        botId,
        reservedNodeIds: [],
        phase: "to-node",
        carried: {},
        lastProgressTs: now,
      });
      quota.updatedAt = now;
    }
    return true;
  }

  tryReserve(quotaId: QuotaId, botId: BotId, nodeId: ResourceNodeId): ReservationResult {
    const quota = this.quotas.get(quotaId);
    if (quota === undefined || quota.status !== "active") return failure("quota-inactive");
    const assignment = quota.assignments.get(botId);
    if (assignment === undefined) return failure("bot-unassigned");
    const holder = quota.reservedNodes.get(nodeId);
    if (holder !== undefined) return holder === botId ? { ok: true } : failure("node-taken");
    const planned = quota.delivered + quota.inFlight + quota.reservedNodes.size;
    if (planned >= quota.target * quota.overprovisionFactor) return failure("over-target");
    quota.reservedNodes.set(nodeId, botId);
    assignment.reservedNodeIds = [...assignment.reservedNodeIds, nodeId];
    assignment.phase = "to-node";
    assignment.lastProgressTs = Date.now();
    return { ok: true };
  }

  release(quotaId: QuotaId, botId: BotId, nodeId: ResourceNodeId): void {
    const quota = this.quotas.get(quotaId);
    if (quota === undefined) return;
    if (quota.reservedNodes.get(nodeId) !== botId) return;
    quota.reservedNodes.delete(nodeId);
    const assignment = quota.assignments.get(botId);
    if (assignment !== undefined) {
      assignment.reservedNodeIds = assignment.reservedNodeIds.filter((id) => id !== nodeId);
    }
  }

  onCarriedChanged(
    quotaId: QuotaId,
    botId: BotId,
    carried: Partial<Record<ResourceKind, number>>,
  ): void {
    const quota = this.quotas.get(quotaId);
    const assignment = quota?.assignments.get(botId);
    if (quota === undefined || assignment === undefined) return;
    const previous = sumValues(assignment.carried);
    const next = sumValues(carried);
    quota.inFlight = Math.max(0, quota.inFlight + next - previous);
    assignment.carried = { ...carried };
    assignment.lastProgressTs = Date.now();
  }

  recordDelivery(quotaId: QuotaId, amount: number, now: TimestampMs = Date.now()): void {
    const quota = this.quotas.get(quotaId);
    if (quota === undefined) return;
    quota.delivered += Math.max(0, amount);
    quota.inFlight = Math.max(0, quota.inFlight - Math.max(0, amount));
    quota.updatedAt = now;
    if (quota.delivered >= quota.target) {
      quota.status = "fulfilled";
      for (const assignment of quota.assignments.values()) assignment.phase = "blocked";
      quota.reservedNodes.clear();
    }
  }

  cancel(quotaId: QuotaId, now: TimestampMs = Date.now()): void {
    const quota = this.quotas.get(quotaId);
    if (quota === undefined) return;
    quota.status = "cancelled";
    quota.updatedAt = now;
    quota.reservedNodes.clear();
  }

  snapshot(): ReadonlyMap<QuotaId, TaskQuota> {
    const copy = new Map<QuotaId, TaskQuota>();
    for (const [id, quota] of this.quotas) copy.set(id, this.clone(quota));
    return copy;
  }

  private clone(quota: MutableQuota): TaskQuota {
    return {
      ...quota,
      reservedNodes: new Map(quota.reservedNodes),
      assignments: new Map(
        [...quota.assignments].map(([id, assignment]) => [
          id,
          { ...assignment, reservedNodeIds: [...assignment.reservedNodeIds], carried: { ...assignment.carried } },
        ]),
      ),
    };
  }
}

function sumValues(values: Partial<Record<ResourceKind, number>>): number {
  let total = 0;
  for (const value of Object.values(values)) total += value ?? 0;
  return total;
}

function failure(reason: ReservationFailureReason): ReservationResult {
  return { ok: false, reason };
}
