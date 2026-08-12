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
  get(id: string): Realm | undefined { return this.realms.get(id); }
  list(): Realm[] { return [...this.realms.values()]; }
  remove(id: string): void {
    const r = this.realms.get(id);
    if (r) { r.stop(); this.realms.delete(id); }
  }
}

export const RealmRegistry = new RealmRegistryImpl();
