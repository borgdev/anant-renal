// Secrets management surface. Interface only — production backs onto a real
// secrets store (Vault, AWS Secrets Manager, GCP Secret Manager). This layer
// gives packs a uniform, testable API and adds an access-audit hook.

export interface SecretsProvider {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  rotate(key: string, newValue: string): Promise<{ previousVersion: number; newVersion: number }>;
  list(prefix?: string): Promise<readonly string[]>;
}

export interface SecretsAudit {
  readonly at: string;
  readonly key: string;
  readonly actorRef: string;
  readonly action: 'read' | 'write' | 'rotate';
  readonly purpose: string;
}

export class AuditingSecretsProvider implements SecretsProvider {
  private readonly log: SecretsAudit[] = [];
  constructor(private readonly inner: SecretsProvider, private readonly actorRef: () => { ref: string; purpose: string }) {}

  async get(key: string): Promise<string | undefined> {
    const a = this.actorRef();
    this.log.push({ at: new Date().toISOString(), key, actorRef: a.ref, action: 'read', purpose: a.purpose });
    return this.inner.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    const a = this.actorRef();
    this.log.push({ at: new Date().toISOString(), key, actorRef: a.ref, action: 'write', purpose: a.purpose });
    await this.inner.set(key, value);
  }
  async rotate(key: string, newValue: string): Promise<{ previousVersion: number; newVersion: number }> {
    const a = this.actorRef();
    this.log.push({ at: new Date().toISOString(), key, actorRef: a.ref, action: 'rotate', purpose: a.purpose });
    return this.inner.rotate(key, newValue);
  }
  async list(prefix?: string): Promise<readonly string[]> {
    return this.inner.list(prefix);
  }
  audit(): readonly SecretsAudit[] { return this.log; }
}

/** Simple in-memory provider for tests + reference. */
export class InMemorySecretsProvider implements SecretsProvider {
  private readonly store = new Map<string, { value: string; version: number }>();
  async get(key: string): Promise<string | undefined> { return this.store.get(key)?.value; }
  async set(key: string, value: string): Promise<void> {
    const cur = this.store.get(key);
    this.store.set(key, { value, version: (cur?.version ?? 0) + 1 });
  }
  async rotate(key: string, newValue: string): Promise<{ previousVersion: number; newVersion: number }> {
    const cur = this.store.get(key);
    const prev = cur?.version ?? 0;
    this.store.set(key, { value: newValue, version: prev + 1 });
    return { previousVersion: prev, newVersion: prev + 1 };
  }
  async list(prefix?: string): Promise<readonly string[]> {
    return Array.from(this.store.keys()).filter((k) => !prefix || k.startsWith(prefix));
  }
}
