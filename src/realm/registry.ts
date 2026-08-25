/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

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
