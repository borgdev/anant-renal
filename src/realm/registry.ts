// RealmRegistry — process-wide index of running realms.
// The admin API queries this to render the realm view.

import { Realm, type RealmOpts } from './realm.js';

class RealmRegistryImpl {
  private realms = new Map<string, Realm>();

  create(opts: RealmOpts): Realm {
    if (this.realms.has(opts.id)) throw new Error(`realm-exists: ${opts.id}`);
    const r = new Realm(opts);
    this.realms.set(opts.id, r);
    return r;
  }
  /** Register an already-constructed Realm (e.g. from a snapshot script). */
  register(realm: Realm): Realm {
    if (this.realms.has(realm.id)) return this.realms.get(realm.id)!;
    this.realms.set(realm.id, realm);
    return realm;
  }
  get(id: string): Realm | undefined { return this.realms.get(id); }
  list(): Realm[] { return [...this.realms.values()]; }
  remove(id: string): void {
    const r = this.realms.get(id);
    if (r) { r.stop(); this.realms.delete(id); }
  }
}

export const RealmRegistry = new RealmRegistryImpl();
