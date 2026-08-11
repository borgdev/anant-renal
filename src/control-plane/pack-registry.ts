// Packs are the extension unit of the harness. The registry enforces
// dependency resolution and version compatibility; runtime enforcement of the
// pack's controls happens in the healthcare-core runtime.

export interface DomainPack {
  id: string;
  version: string;
  extends: ReadonlyArray<{ id: string; versionRange: string }>;
  appliesTo: {
    organizationKinds: readonly string[];
    facilityKinds?: readonly string[];
  };
  capabilities: readonly string[];
  cmsUniverse: ReadonlyArray<{
    id: string;
    title: string;
    authority: string;
    effectiveFrom?: string;
  }>;
  requiredControls: readonly string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(v: string): [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`Invalid version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Minimal caret-range check (`^A.B.C`) — enough for pack manifests. */
export function satisfies(version: string, range: string): boolean {
  if (range.startsWith('^')) {
    const [rMaj, rMin, rPatch] = parseVersion(range.slice(1));
    const [vMaj, vMin, vPatch] = parseVersion(version);
    if (rMaj === 0) {
      // ^0.x.y is only compatible with the same minor
      return vMaj === 0 && vMin === rMin && (vPatch > rPatch || (vPatch === rPatch));
    }
    if (vMaj !== rMaj) return false;
    if (vMin > rMin) return true;
    if (vMin < rMin) return false;
    return vPatch >= rPatch;
  }
  return version === range;
}

export class PackRegistry {
  private readonly packs = new Map<string, DomainPack>();

  register(pack: DomainPack): void {
    if (this.packs.has(pack.id)) throw new Error(`Pack already registered: ${pack.id}`);
    for (const dep of pack.extends) {
      const found = this.packs.get(dep.id);
      if (!found) throw new Error(`Unresolved dependency ${dep.id} for pack ${pack.id}`);
      if (!satisfies(found.version, dep.versionRange)) {
        throw new Error(`Pack ${pack.id} requires ${dep.id}@${dep.versionRange}, found ${found.version}`);
      }
    }
    this.packs.set(pack.id, Object.freeze({ ...pack }));
  }

  resolve(id: string): DomainPack {
    const pack = this.packs.get(id);
    if (!pack) throw new Error(`Unknown pack: ${id}`);
    return pack;
  }

  all(): readonly DomainPack[] {
    return [...this.packs.values()];
  }
}
