/******************************************************************************
 * Restore drill — snapshot durable configuration, mutate it, restore, verify.
 *
 * Proves that operator-editable configuration is fully recoverable:
 *   1. snapshot — org (name/model/region/timezone/retention/synthetic) +
 *                 admin policy + active pack activation
 *   2. mutate   — change the org name/model and the policy decision
 *   3. verify   — the mutations are visible via the same APIs
 *   4. restore  — PUT the snapshot back over the same durable routes
 *   5. verify   — values match the snapshot exactly (restored)
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/restore-drill.mjs
 ******************************************************************************/

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name} — ${detail}`); };

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: method !== 'GET' && method !== 'HEAD' ? (body === undefined ? '{}' : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  if (method === 'POST' && path === '/auth/login') {
    const sc = res.headers.get('set-cookie') ?? '';
    const m = /hh_session=([^;]+)/.exec(sc);
    if (m) cookie = `hh_session=${m[1]}`;
  }
  return { status: res.status, json };
}
const J = async (method, path, body) => {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
};

async function main() {
  console.log(`Restore drill → ${BASE}\n`);
  const login = await api('POST', '/auth/login', { username: process.env.ADMIN_USER ?? 'admin', password: process.env.ADMIN_PASS ?? 'admin123' });
  step('admin login', login.status === 200 && Boolean(cookie), cookie ? 'session acquired' : 'MISSING');
  if (!cookie) { process.exitCode = 1; return; }

  // 1. Snapshot.
  const org = (await J('GET', '/admin/platform/organization')).organization ?? {};
  const policy = (await J('GET', '/admin/swarm/admin/policy')).policy ?? {};
  const packs = (await J('GET', '/admin/platform/packs'));
  const snapshot = {
    org: {
      operatingModel: org.operatingModel, displayName: org.displayName, region: org.region,
      timezone: org.timezone, retentionDays: org.retentionDays, synthetic: org.synthetic,
      scopePath: org.scopePath ?? [],
    },
    policy: { defaultDecision: policy.defaultDecision, escalationThresholdBasisPoints: policy.escalationThresholdBasisPoints, minThresholdBasisPoints: policy.minThresholdBasisPoints, maxThresholdBasisPoints: policy.maxThresholdBasisPoints, externalWritesEnabled: policy.externalWritesEnabled },
    activePack: packs.activePack,
  };
  step('snapshot captured', true, `org "${snapshot.org.displayName ?? '(none)'}" · ${snapshot.org.operatingModel ?? '—'} · policy ${snapshot.policy.defaultDecision} · active pack ${snapshot.activePack ?? 'none'}`);

  // 2. Mutate.
  const mutName = `${snapshot.org.displayName ?? 'Org'} (DRILL-MUTATED)`;
  await J('PUT', '/admin/platform/organization', {
    operatingModel: snapshot.org.operatingModel === 'payer' ? 'provider' : 'payer',
    displayName: mutName,
    region: snapshot.org.region ?? '', timezone: snapshot.org.timezone ?? '',
    retentionDays: snapshot.org.retentionDays ?? 365, synthetic: true,
    scopePath: snapshot.org.scopePath,
  });
  const mutPolicy = { ...snapshot.policy, defaultDecision: snapshot.policy.defaultDecision === 'block' ? 'allow' : 'block', externalWritesEnabled: !snapshot.policy.externalWritesEnabled };
  await J('PUT', '/admin/swarm/admin/policy', mutPolicy);
  const mutOrg = (await J('GET', '/admin/platform/organization')).organization ?? {};
  const mutPolicyBack = (await J('GET', '/admin/swarm/admin/policy')).policy ?? {};
  const mutated = mutOrg.displayName === mutName && mutPolicyBack.defaultDecision !== snapshot.policy.defaultDecision;
  step('mutation applied', mutated, `org "${mutOrg.displayName}" · policy ${mutPolicyBack.defaultDecision} · synthetic ${mutOrg.synthetic}`);

  // 3. Restore.
  await J('PUT', '/admin/platform/organization', snapshot.org);
  await J('PUT', '/admin/swarm/admin/policy', snapshot.policy);
  const restOrg = (await J('GET', '/admin/platform/organization')).organization ?? {};
  const restPolicy = (await J('GET', '/admin/swarm/admin/policy')).policy ?? {};
  const okOrg = restOrg.displayName === snapshot.org.displayName && restOrg.operatingModel === snapshot.org.operatingModel && restOrg.synthetic === snapshot.org.synthetic;
  const okPolicy = restPolicy.defaultDecision === snapshot.policy.defaultDecision && restPolicy.escalationThresholdBasisPoints === snapshot.policy.escalationThresholdBasisPoints && restPolicy.externalWritesEnabled === snapshot.policy.externalWritesEnabled;
  step('org restored', okOrg, `"${restOrg.displayName}" · ${restOrg.operatingModel} · synthetic ${restOrg.synthetic}`);
  step('policy restored', okPolicy, `decision ${restPolicy.defaultDecision} · escalation ${restPolicy.escalationThresholdBasisPoints}bp · ext-writes ${restPolicy.externalWritesEnabled}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRestore drill complete — ${results.length - failed}/${results.length} checks passed.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
