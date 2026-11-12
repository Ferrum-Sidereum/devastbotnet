import type { IffRegistry, IffRelation, Vec2 } from "./types.js";
import type { CircleBody, SpatialHashGrid } from "./spatial-hash.js";

/** Mutable IFF registry, owned by the single-writer world loop. */
export class IffRegistryStore implements IffRegistry {
  private readonly whitelistPlayersSet = new Set<string>();
  private readonly whitelistClansSet = new Set<string>();
  private readonly blacklistPlayersSet = new Set<string>();
  private readonly blacklistClansSet = new Set<string>();
  private currentVersion = 0;

  constructor(public selfName: string | null = null) {}

  resolve(name: string | undefined, clanTag?: string): IffRelation {
    const normalized = name?.trim().toLowerCase();
    const clan = clanTag?.trim().toLowerCase();
    if (normalized !== undefined && normalized.length > 0 && normalized === this.selfName?.toLowerCase()) {
      return "SELF";
    }
    if (
      (normalized !== undefined && this.whitelistPlayersSet.has(normalized)) ||
      (clan !== undefined && this.whitelistClansSet.has(clan))
    ) {
      return "WHITELIST";
    }
    if (
      (normalized !== undefined && this.blacklistPlayersSet.has(normalized)) ||
      (clan !== undefined && this.blacklistClansSet.has(clan))
    ) {
      return "BLACKLIST";
    }
    return "NEUTRAL";
  }

  addWhitelist(player?: string, clan?: string): void {
    if (player !== undefined && player.length > 0) this.whitelistPlayersSet.add(player.toLowerCase());
    if (clan !== undefined && clan.length > 0) this.whitelistClansSet.add(clan.toLowerCase());
    this.currentVersion += 1;
  }

  addBlacklist(player?: string, clan?: string): void {
    if (player !== undefined && player.length > 0) this.blacklistPlayersSet.add(player.toLowerCase());
    if (clan !== undefined && clan.length > 0) this.blacklistClansSet.add(clan.toLowerCase());
    this.currentVersion += 1;
  }

  removeWhitelist(player?: string, clan?: string): void {
    if (player !== undefined) this.whitelistPlayersSet.delete(player.toLowerCase());
    if (clan !== undefined) this.whitelistClansSet.delete(clan.toLowerCase());
    this.currentVersion += 1;
  }

  removeBlacklist(player?: string, clan?: string): void {
    if (player !== undefined) this.blacklistPlayersSet.delete(player.toLowerCase());
    if (clan !== undefined) this.blacklistClansSet.delete(clan.toLowerCase());
    this.currentVersion += 1;
  }

  get whitelistPlayers(): ReadonlySet<string> {
    return this.whitelistPlayersSet;
  }

  get whitelistClans(): ReadonlySet<string> {
    return this.whitelistClansSet;
  }

  get blacklistPlayers(): ReadonlySet<string> {
    return this.blacklistPlayersSet;
  }

  get blacklistClans(): ReadonlySet<string> {
    return this.blacklistClansSet;
  }

  get version(): number {
    return this.currentVersion;
  }
}

export interface FriendlyFireCheck {
  blocked: boolean;
  blocker: CircleBody | null;
}

/** Friendly-fire gate (Architecture v2, ADR-006). */
export function checkFriendlyFire(
  grid: SpatialHashGrid,
  shooter: Vec2,
  impact: Vec2,
  padding = 0,
): FriendlyFireCheck {
  const blocker = grid.firstBlockingAlly(shooter, impact, padding);
  return { blocked: blocker !== null, blocker };
}

/** Symmetric fan angles for focus fire; the first bot keeps the center line. */
export function focusFireOffsets(count: number, spacingRadians = 0.2): number[] {
  if (count <= 0) return [];
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const slot = i % 2 === 0 ? i / 2 : -(i + 1) / 2;
    offsets.push(slot * spacingRadians);
  }
  return offsets;
}
