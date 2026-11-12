import type { EntityId, Vec2 } from "./types.js";

/**
 * Spatial hash for O(1)-ish friendly-fire checks (Architecture v2, ADR-006).
 *
 * Cell size should be the maximum projectile range so a shot segment touches
 * only a handful of cells. Cell keys are strings to avoid hash collisions
 * silently merging unrelated regions; for 10^3 bodies this is not the hot path.
 */
export type BodyKind = "self" | "ally-bot" | "whitelist" | "blacklist" | "neutral";

export interface CircleBody {
  id: EntityId;
  pos: Vec2;
  radius: number;
  kind: BodyKind;
}

interface Hit {
  body: CircleBody;
  /** Normalized position along the segment, 0..1. */
  t: number;
}

function cellCoordinate(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

function cellKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

function segmentCircleT(a: Vec2, b: Vec2, center: Vec2, radius: number): number | null {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const acx = center.x - a.x;
  const acz = center.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t =
    lengthSq <= 1e-12
      ? 0
      : Math.max(0, Math.min(1, (acx * abx + acz * abz) / lengthSq));
  const closestX = a.x + abx * t;
  const closestZ = a.z + abz * t;
  const dx = center.x - closestX;
  const dz = center.z - closestZ;
  return dx * dx + dz * dz <= radius * radius ? t : null;
}

export class SpatialHashGrid {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Map<EntityId, CircleBody>>();
  private readonly bodyCell = new Map<EntityId, string>();

  constructor(cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError(`cellSize must be a positive finite number, got ${cellSize}`);
    }
    this.cellSize = cellSize;
  }

  upsert(body: CircleBody): void {
    this.remove(body.id);
    const key = cellKey(
      cellCoordinate(body.pos.x, this.cellSize),
      cellCoordinate(body.pos.z, this.cellSize),
    );
    let cell = this.cells.get(key);
    if (cell === undefined) {
      cell = new Map();
      this.cells.set(key, cell);
    }
    cell.set(body.id, body);
    this.bodyCell.set(body.id, key);
  }

  remove(id: EntityId): void {
    const key = this.bodyCell.get(id);
    if (key === undefined) return;
    this.bodyCell.delete(id);
    const cell = this.cells.get(key);
    if (cell === undefined) return;
    cell.delete(id);
    if (cell.size === 0) this.cells.delete(key);
  }

  /** Bodies whose cells overlap the padded segment bounding box. */
  querySegment(a: Vec2, b: Vec2, padding = 0): CircleBody[] {
    const found: CircleBody[] = [];
    for (const hit of this.queryHits(a, b, padding)) found.push(hit.body);
    return found;
  }

  /**
   * Nearest body that must not be hit (self, allied bot, whitelisted player).
   * Returns null when the line of fire is clear.
   */
  firstBlockingAlly(a: Vec2, b: Vec2, padding = 0): CircleBody | null {
    let best: Hit | null = null;
    for (const hit of this.queryHits(a, b, padding)) {
      if (hit.body.kind === "blacklist" || hit.body.kind === "neutral") continue;
      if (best === null || hit.t < best.t) best = hit;
    }
    return best?.body ?? null;
  }

  private queryHits(a: Vec2, b: Vec2, padding: number): Hit[] {
    if (!Number.isFinite(padding) || padding < 0) {
      throw new RangeError(`padding must be a non-negative finite number, got ${padding}`);
    }
    const minX = Math.min(a.x, b.x) - padding;
    const maxX = Math.max(a.x, b.x) + padding;
    const minZ = Math.min(a.z, b.z) - padding;
    const maxZ = Math.max(a.z, b.z) + padding;
    const cx0 = cellCoordinate(minX, this.cellSize);
    const cx1 = cellCoordinate(maxX, this.cellSize);
    const cz0 = cellCoordinate(minZ, this.cellSize);
    const cz1 = cellCoordinate(maxZ, this.cellSize);

    const hits: Hit[] = [];
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const cell = this.cells.get(cellKey(cx, cz));
        if (cell === undefined) continue;
        for (const body of cell.values()) {
          const t = segmentCircleT(a, b, body.pos, body.radius + padding);
          if (t !== null) hits.push({ body, t });
        }
      }
    }
    return hits;
  }
}

