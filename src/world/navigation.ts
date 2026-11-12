/**
 * Chunked navigation grid with budgeted flow-field rebuilds
 * (Architecture v2, ADR-005).
 *
 * The first implementation computes a global BFS integration field but only
 * when the dirty-chunk/tile budget allows it; walls mark the touched chunk and
 * its neighbours dirty. The chunk-local hierarchical refinement can replace the
 * rebuild internals without changing this API.
 */
export interface GridPoint {
  x: number;
  z: number;
}

export interface FlowVector {
  x: -1 | 0 | 1;
  z: -1 | 0 | 1;
}

export interface NavOptions {
  width: number;
  height: number;
  chunkSize: number;
  maxTilesPerTick: number;
}

const UNREACHABLE = 0xffffffff;

export class ChunkedFlowGrid {
  readonly width: number;
  readonly height: number;
  readonly chunkSize: number;
  private readonly maxTilesPerTick: number;
  private readonly blocked: Uint8Array;
  private readonly dirtyChunks = new Set<string>();
  private integration: Uint32Array | null = null;
  private flow: Int8Array | null = null;
  private target: GridPoint | null = null;
  private lastBuiltTiles = 0;

  constructor(options: NavOptions) {
    if (options.width <= 0 || options.height <= 0 || options.chunkSize <= 0) {
      throw new RangeError("grid dimensions and chunkSize must be positive");
    }
    this.width = options.width;
    this.height = options.height;
    this.chunkSize = options.chunkSize;
    this.maxTilesPerTick = options.maxTilesPerTick;
    this.blocked = new Uint8Array(this.width * this.height);
  }

  setBlocked(x: number, z: number, blocked: boolean): void {
    if (!this.inBounds(x, z)) return;
    const index = this.index(x, z);
    if (this.blocked[index] === (blocked ? 1 : 0)) return;
    this.blocked[index] = blocked ? 1 : 0;
    this.markChunkDirty(x, z);
  }

  isBlocked(x: number, z: number): boolean {
    return !this.inBounds(x, z) || this.blocked[this.index(x, z)] === 1;
  }

  setTarget(target: GridPoint | null): void {
    this.target = target;
    this.dirtyChunks.clear();
    for (let cz = 0; cz < Math.ceil(this.height / this.chunkSize); cz += 1) {
      for (let cx = 0; cx < Math.ceil(this.width / this.chunkSize); cx += 1) {
        this.dirtyChunks.add(`${cx}:${cz}`);
      }
    }
    this.integration = null;
    this.flow = null;
  }

  /** Rebuilds the field if the tile budget allows; otherwise leaves it deferred. */
  rebuild(): { built: boolean; tiles: number; deferredChunks: number } {
    if (this.target === null) return { built: false, tiles: 0, deferredChunks: this.dirtyChunks.size };
    const totalTiles = this.width * this.height;
    if (totalTiles > this.maxTilesPerTick) {
      return { built: false, tiles: 0, deferredChunks: this.dirtyChunks.size };
    }
    if (this.dirtyChunks.size === 0 && this.integration !== null) {
      return { built: false, tiles: 0, deferredChunks: 0 };
    }
    const integration = new Uint32Array(totalTiles).fill(UNREACHABLE);
    const queue = new Int32Array(totalTiles);
    let head = 0;
    let tail = 0;
    const start = this.index(this.target.x, this.target.z);
    if (!this.isBlocked(this.target.x, this.target.z)) {
      integration[start] = 0;
      queue[tail++] = start;
    }
    while (head < tail) {
      const current = queue[head];
      if (current === undefined) break;
      head += 1;
      const cx = current % this.width;
      const cz = Math.floor(current / this.width);
      const base = integration[current]!;
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!this.inBounds(nx, nz) || this.isBlocked(nx, nz)) continue;
        const next = this.index(nx, nz);
        if (integration[next] !== UNREACHABLE) continue;
        integration[next] = base + 1;
        queue[tail++] = next;
      }
    }
    const flow = new Int8Array(totalTiles * 2);
    for (let z = 0; z < this.height; z += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const index = this.index(x, z);
        if (integration[index] === UNREACHABLE || integration[index] === 0) continue;
        let best = integration[index]!;
        let bestDx = 0;
        let bestDz = 0;
        for (const [dx, dz] of NEIGHBOURS) {
          const nx = x + dx;
          const nz = z + dz;
          if (!this.inBounds(nx, nz) || this.isBlocked(nx, nz)) continue;
          const value = integration[this.index(nx, nz)]!;
          if (value < best) {
            best = value;
            bestDx = dx;
            bestDz = dz;
          }
        }
        flow[index * 2] = bestDx;
        flow[index * 2 + 1] = bestDz;
      }
    }
    this.integration = integration;
    this.flow = flow;
    this.lastBuiltTiles = totalTiles;
    this.dirtyChunks.clear();
    return { built: true, tiles: totalTiles, deferredChunks: 0 };
  }

  flowAt(x: number, z: number): FlowVector | null {
    if (this.flow === null || !this.inBounds(x, z)) return null;
    const index = this.index(x, z);
    if (this.integration?.[index] === 0 || this.integration?.[index] === UNREACHABLE) return null;
    return { x: this.flow[index * 2] as -1 | 0 | 1, z: this.flow[index * 2 + 1] as -1 | 0 | 1 };
  }

  isDirty(x: number, z: number): boolean {
    return this.dirtyChunks.has(this.chunkKey(x, z));
  }

  get dirtyCount(): number {
    return this.dirtyChunks.size;
  }

  get lastBuiltTileCount(): number {
    return this.lastBuiltTiles;
  }

  private markChunkDirty(x: number, z: number): void {
    const cx = Math.floor(x / this.chunkSize);
    const cz = Math.floor(z / this.chunkSize);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0) continue;
        if (nx >= Math.ceil(this.width / this.chunkSize) || nz >= Math.ceil(this.height / this.chunkSize)) continue;
        this.dirtyChunks.add(`${nx}:${nz}`);
      }
    }
    this.integration = null;
    this.flow = null;
  }

  private chunkKey(x: number, z: number): string {
    return `${Math.floor(x / this.chunkSize)}:${Math.floor(z / this.chunkSize)}`;
  }

  private index(x: number, z: number): number {
    return z * this.width + x;
  }

  private inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.width && z < this.height;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
