/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

import { loadFailureHTML } from '../core/scope.js';
import { main } from '../core/shell.js';
import { esc, hydrateIcons, toast } from '../core/theme.js';
import { cfgSpecsBody } from './agent-specs.js';
import { cfgObjectsBody } from './exec-substrate.js';
import { cfgOntologyBody } from './ontology.js';
import { plFetch } from './platform-admin.js';

export const CFG_TABS = [['packs', 'Packs & lens'], ['objects', 'Configuration objects'], ['specs', 'Agent specs'], ['ontology', 'Ontology'], ['policy', 'Action policy']];

export let cfgActivePack = null;

export async function cfgBody(ctx) {
  const body = document.getElementById('cfg-body');
  if (!body) return;

  if (cfgTab === 'packs') {
    const levels = Object.values(cfgConformance);
    const conformant = levels.filter((c) => c.level === 'conformant' || c.level === 'substrate').length;
    const nonconformant = levels.filter((c) => c.level === 'nonconformant').length;
    body.innerHTML = `
      <h3 style="margin-top:0;">Pack registry <span class="muted" style="font-weight:400;font-size:11px;">· ${cfgPacks.length} installed by the pack loader</span></h3>
      <p class="muted" style="font-size:12px;">Activating a pack durably switches the executive lens in <code>/api/context</code> — no redeploy, no operating-model edit. Deactivate restores the operating-model default. Currently serving lens <b>${esc((ctx.pack && ctx.pack.lens) || '—')}</b> from pack <b>${esc((ctx.pack && ctx.pack.id) || '—')}</b>.</p>
      <div class="muted" style="font-size:12px;margin-bottom:8px;">Specialty contract: <b>${conformant}/${levels.length || 0}</b> at or above conformant${nonconformant ? ` · <span style="color:var(--bad);">${nonconformant} nonconformant and blocked from activation</span>` : ''}. A pack marked <span class="pill amber">partial</span> is installable but has not declared every clinical section yet — hover for the list.</div>
      ${cfgResources || cfgManifestIssues.length ? `<div class="muted" style="font-size:12px;margin-bottom:8px;">Declared surface across the installed manifests: <b>${cfgResources ? cfgResources.total : 0}</b> resolved artifacts · <b>${cfgResources ? cfgResources.eventTypes : 0}</b> canonical event types · <b>${cfgResources ? cfgResources.resolvedPacks : 0}</b> packs resolved${cfgResources && cfgResources.blockedPacks && cfgResources.blockedPacks.length ? ` · <span style="color:var(--bad);">${esc(cfgResources.blockedPacks.join(', '))} blocked</span>` : ''}. Each artifact names a module that must exist, every workflow subscription must be to a declared event, and every CMS-bound measure must name an authority the pack declared.</div>` : ''}
      ${cfgManifestIssues.length ? `<div style="color:var(--bad);font-size:12px;margin-bottom:8px;">${cfgManifestIssues.length} manifest issue(s): ${esc(cfgManifestIssues.map((i) => `${i.packId} — ${i.detail}`).join('; '))}</div>` : ''}
      <div style="display:grid;gap:8px;">${cfgPacks.map((p) => packRegistryRow(p, cfgActivePack)).join('') || '<span class="muted" style="font-size:12px;">No packs installed.</span>'}</div>`;
    return;
  }

  if (cfgTab === 'objects') { await cfgObjectsBody(); return; }
  if (cfgTab === 'specs') { await cfgSpecsBody(); return; }
  if (cfgTab === 'ontology') { await cfgOntologyBody(); return; }

  // Action policy — the red-team suite evaluates THIS live, so an unsafe policy
  // fails the suite and blocks a release.
  let policy = null; let perr = null;
  try { policy = (await plFetch('GET', '/admin/platform/policy')).policy; } catch (e) { perr = e.message; }
  if (!policy) { body.innerHTML = loadFailureHTML('the action-boundary policy', perr); hydrateIcons(); return; }
  body.innerHTML = `
    <h3 style="margin-top:0;">Action-boundary policy</h3>
    <p class="muted" style="font-size:12px;">Stored in Postgres and read live by the red-team suite and the release gate. Version <code>${esc(policy.version || '—')}</code>, last updated ${esc(String(policy.updatedAt || '—'))}.</p>
    <div class="field-row">
      <div class="field"><label>Default decision</label><select id="cfg-decision"><option value="block" ${policy.defaultDecision === 'block' ? 'selected' : ''}>block (deny by default)</option><option value="allow" ${policy.defaultDecision === 'allow' ? 'selected' : ''}>allow</option></select></div>
      <div class="field"><label>Version</label><input id="cfg-version" value="${esc(policy.version || '')}" /></div>
      <div class="field"><label>Escalation consensus (bp)</label><input id="cfg-escalation" type="number" value="${policy.escalationThresholdBasisPoints}" /></div>
      <div class="field"><label>Min threshold (bp)</label><input id="cfg-min" type="number" value="${policy.minThresholdBasisPoints}" /></div>
      <div class="field"><label>Max threshold (bp)</label><input id="cfg-max" type="number" value="${policy.maxThresholdBasisPoints}" /></div>
      <div class="field"><label style="display:block;"><input id="cfg-extwrites" type="checkbox" ${policy.externalWritesEnabled ? 'checked' : ''} /> External writes enabled</label></div>
      <div class="field" style="align-self:flex-end;"><button class="btn btn-primary" onclick="plConfigSavePolicy()">Save policy</button></div>
    </div>
    <div id="cfg-policy-out" class="muted" style="font-size:12px;margin-top:6px;">Escalation is enforced between the min and max bounds; the server rejects values outside 0–10000 basis points.</div>`;
  hydrateIcons();
}

export let cfgPacks = [];

/** pack id → conformance report, from the Phase 0 specialty contract. */
export let cfgConformance = {};

/** The platform-owned resource totals + manifest issues from the Phase 3
 *  resolution pass (what the installed manifests collectively declare). */
export let cfgResources = null;

/** Manifest files that could not be parsed or resolved. A manifest is the
 *  artifact a second specialty arrives through, so a broken one is news. */
export let cfgManifestIssues = [];

export let cfgTab = 'packs';

/** What a pack's OWN manifest says it contributes, and whether that resolved.
 *
 * This is the Phase 3 half of the contract: a declaration is only worth reading
 * if it is checked. A pack that names an ontology it does not ship, or measures
 * bound to a CMS authority it never declared, is reported here rather than
 * discovered as a runtime failure in a specialty the platform already hosts. */
function declaredSurfaceRow(p) {
  const m = p.manifest;
  if (!m || !m.present) {
    return `<div class="muted" style="font-size:11px;margin-top:3px;">no manifest · identity comes from the pack descriptor alone</div>`;
  }
  const parts = [];
  if (m.ontology) parts.push(`ontology <b>${esc(m.ontology.id)}</b> (${(m.ontology.concepts || []).length} concepts)`);
  if ((m.eventTypes || []).length) parts.push(`${m.eventTypes.length} event types`);
  if ((m.workflows || []).length) parts.push(`${m.workflows.length} workflows`);
  if ((m.measures || []).length) parts.push(`${m.measures.length} measure${m.measures.length === 1 ? '' : 's'}`);
  if (m.lens) parts.push(`lens <b>${esc(m.lens.label)}</b>`);
  if (!parts.length) {
    return `<div class="muted" style="font-size:11px;margin-top:3px;">manifest declares no specialty surface — this pack is a dependency, not a specialty</div>`;
  }
  const blocking = (m.issues || []).filter((i) => i.blocking);
  const drift = m.drift || [];
  return `<div class="muted" style="font-size:11px;margin-top:3px;">declares ${parts.join(' · ')}
    ${drift.length ? `<div style="color:var(--warn);font-size:11px;">manifest drift: ${esc(drift.map((d) => d.field).join(', '))} — the manifest and the pack descriptor disagree, so a reader may be told one thing while the runtime does another</div>` : ''}
    ${blocking.length ? `<div style="color:var(--bad);font-size:11px;">unresolved: ${esc(blocking.map((i) => i.detail).join('; '))}</div>` : ''}</div>`;
}

/** The conformance pill for one pack. `substrate` is a distinct state: the
 *  healthcare-core pack is the platform floor, not a specialty, so it is never
 *  "incomplete" for lacking clinical sections. */
function conformancePill(p) {
  const c = cfgConformance[p.id];
  if (!c) return '';
  const cls = c.level === 'conformant' || c.level === 'substrate' ? 'mint'
    : c.level === 'partial' ? 'amber' : 'red';
  const label = c.level === 'substrate' ? 'platform floor' : c.level;
  return `<span class="pill ${cls}" title="${esc(c.missingSections && c.missingSections.length ? 'missing: ' + c.missingSections.join(', ') : 'all sections declared')}">contract · ${esc(label)}</span>`;
}

export function packRegistryRow(p, activePackId) {
  const isActive = p.active || p.id === activePackId;
  const c = cfgConformance[p.id];
  const missing = (c && c.missingSections) || [];
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid ${isActive ? 'rgba(0,168,112,.35)' : 'var(--line)'};border-radius:8px;background:${isActive ? 'rgba(0,168,112,.06)' : 'color-mix(in srgb, var(--elevate) 2%, transparent)'};">
    <div style="min-width:0;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><strong style="font-size:13px;">${esc(p.id)}</strong><span class="pill muted">v${esc(p.version)}</span>${conformancePill(p)}<span class="pill ${p.lens === 'payer' ? 'amber' : p.lens === 'hybrid' ? 'violet' : 'mint'}">lens · ${esc(p.lens)}</span>${isActive ? '<span class="pill green">active</span>' : ''}</div>
      <div class="muted" style="font-size:11px;margin-top:3px;">${(p.capabilities || []).length} capabilities · ${(p.cmsUniverse || []).length} CMS authorities · extends ${esc((p.extends || []).join(', ') || 'none')} · applies to ${esc((p.appliesTo && p.appliesTo.organizationKinds || []).join(', '))}${missing.length ? ` · <span style="color:var(--warn);">undeclared: ${esc(missing.join(', '))}</span>` : ''}</div>
      ${declaredSurfaceRow(p)}
    </div>
    <div style="flex:0 0 auto;display:flex;gap:6px;">
      ${isActive
        ? `<button class="btn btn-ghost" onclick="plPackDeactivate()">Deactivate</button>`
        : `<button class="btn btn-primary" onclick="plPackActivate('${esc(p.id)}')">Activate</button>`}
    </div>
  </div>`;
}

export async function plPackActivate(id) {
  try {
    const r = await plFetch('POST', '/admin/platform/packs/' + encodeURIComponent(id) + '/activate', { by: 'platform-admin' });
    toast('Pack activated · lens ' + (r.pack ? r.pack.lens : '') + ' · ' + id);
  } catch (e) { toast(e.message, 'err'); }
  renderPlatformConfig();
}

export async function plPackDeactivate() {
  try {
    await plFetch('POST', '/admin/platform/packs/deactivate', { by: 'platform-admin' });
    toast('Pack deactivated — operating-model default restored');
  } catch (e) { toast(e.message, 'err'); }
  renderPlatformConfig();
}

export async function renderPlatformConfig() {
  let ctx = { pack: { id: '', lens: '' } };
  let err = null;
  try {
    ctx = await plFetch('GET', '/api/context');
    const list = await plFetch('GET', '/admin/platform/packs');
    cfgPacks = list.packs || [];
    cfgActivePack = list.activePack || null;
    const conf = await plFetch('GET', '/admin/platform/packs/conformance').catch(() => ({ packs: [] }));
    cfgConformance = Object.fromEntries((conf.packs || []).map((c) => [c.packId, c]));
    cfgResources = conf.resources || null;
    cfgManifestIssues = conf.manifestIssues || [];
  } catch (e) { err = e.message; }
  if (err) {
    main.innerHTML = `<div class="page-header"><div><h2 class="page-title">Configuration studio</h2></div></div>${loadFailureHTML('the configuration studio', err)}`;
    hydrateIcons();
    return;
  }
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Configuration studio</h2>
      <p class="page-sub">What the next release will change — installed packs and the lens they switch, the durable configuration objects the executive console renders, the organization ontology, and the action-boundary policy. Release lifecycle and gate evidence live in <b>Release center</b>.</p></div>
      <button class="btn" onclick="goTo('platform-releases')">Release center →</button></div>
    <div class="section-card">
      <div class="page-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${CFG_TABS.map(([id, label]) => `<button class="tab${cfgTab === id ? ' is-active' : ''}" onclick="cfgGo('${id}')">${label}</button>`).join('')}</div>
      <div id="cfg-body">Loading…</div>
    </div>`;
  await cfgBody(ctx);
  hydrateIcons();
}
