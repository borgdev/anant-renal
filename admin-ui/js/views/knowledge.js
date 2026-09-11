import { api } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export let knowledgeFilter = { category: '', tier: '', domain: '' };

export async function openCredentialSheet(id) {
  const drawer = document.getElementById('provenance-drawer');
  drawer.innerHTML = 'Loading…'; drawer.style.right = '0';
  const [creds, spec] = await Promise.all([
    api('GET', `/admin/knowledge/credentials/${encodeURIComponent(id)}`),
    api('GET', `/admin/knowledge/sources/${encodeURIComponent(id)}`),
  ]);
  const setup = creds.spec;
  drawer.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>Set credentials — ${esc(spec.spec.name)}</h3><button class="btn" onclick="document.getElementById('provenance-drawer').style.right='-560px'">Close</button></div>
    ${setup ? `
      <p>${esc(setup.description || '')}</p>
      <p><strong>${esc(setup.registerLabel)}</strong>: <a href="${esc(setup.registerUrl)}" target="_blank">${esc(setup.registerUrl)}</a></p>
      <p class="muted" style="font-size:12px">Estimated ${esc(setup.estimatedTime)} · ${esc(setup.cost)}</p>
      <h4>Steps</h4>
      <ol>${(setup.steps||[]).map(s => `<li>${esc(s.text)}${s.link ? ` <a href="${esc(s.link.url)}" target="_blank">${esc(s.link.label)}</a>` : ''}${s.subSteps ? `<ul>${s.subSteps.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>
      <h4>Fields</h4>
      <form id="cred-form">${(setup.fields||[]).map(f => `
        <div class="form-row" style="margin:8px 0"><label>${esc(f.label)}</label><input type="${f.kind==='password'?'password':'text'}" name="${esc(f.name)}" placeholder="${esc(f.placeholder||'')}" ${f.required===false?'':'required'}></div>
      `).join('')}</form>
      <div style="display:flex;gap:6px;margin-top:12px">
        <button class="btn primary" onclick="saveCreds('${esc(id)}')">Save</button>
        <button class="btn" onclick="testCreds('${esc(id)}',this)">Test</button>
      </div>
      <div id="cred-status" class="muted" style="margin-top:10px"></div>
    ` : '<p class="muted">No credentials required for this source.</p>'}
  `;
}

export async function openProvenance(id) {
  const drawer = document.getElementById('provenance-drawer');
  drawer.innerHTML = 'Loading…'; drawer.style.right = '0';
  const [spec, arts] = await Promise.all([
    api('GET', `/admin/knowledge/sources/${encodeURIComponent(id)}`),
    api('GET', `/admin/knowledge/artifacts/${encodeURIComponent(id)}?limit=25`),
  ]);
  drawer.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>${esc(spec.spec.name)}</h3><button class="btn" onclick="document.getElementById('provenance-drawer').style.right='-560px'">Close</button></div>
    <div class="muted" style="font-size:12px">${esc(spec.spec.id)} · ${esc(spec.spec.publisher)}</div>
    <p>${esc(spec.spec.description || '')}</p>
    <p><a href="${esc(spec.spec.homepage)}" target="_blank">Publisher homepage</a></p>
    ${spec.manifest ? `<div class="muted" style="font-size:12px">Last sync ${new Date(spec.manifest.lastSyncedAt).toLocaleString()} · upstream ${esc(spec.manifest.upstreamVersion || 'n/a')} · ${spec.manifest.artifactIndex.length} artifacts</div>` : '<div class="muted">Not yet synced.</div>'}
    <h4 style="margin-top:16px">Latest artifacts (${arts.total})</h4>
    <ul style="padding-left:16px">${(arts.artifacts||[]).map(a => `<li><a href="${esc(a.upstream.rawUrl)}" target="_blank">${esc(a.title)}</a><div class="muted" style="font-size:11px">sha256 ${esc(a.upstream.contentHash.slice(0,16))}… · fetched ${new Date(a.upstream.fetchedAt).toLocaleString()}</div></li>`).join('')}</ul>
  `;
}

export async function renderResearch() {
  const q = new URLSearchParams();
  if (knowledgeFilter.category) q.set('category', knowledgeFilter.category);
  if (knowledgeFilter.tier) q.set('tier', knowledgeFilter.tier);
  if (knowledgeFilter.domain) q.set('clinicalDomain', knowledgeFilter.domain);
  const [d, reach] = await Promise.all([
    api('GET', '/admin/knowledge/sources' + (q.toString() ? '?' + q : '')),
    api('GET', '/admin/knowledge/reach'),
  ]);
  const cats = [...new Set(d.sources.map(s => s.category))].sort();
  const tiers = [...new Set(d.sources.map(s => s.tier))].sort();
  const doms = [...new Set(d.sources.flatMap(s => s.clinicalDomains))].sort();
  const reachMap = Object.fromEntries((reach.table || []).map(r => [r.sourceId, r]));
  const grouped = {}; for (const s of d.sources) (grouped[s.category] ??= []).push(s);
  main.innerHTML = `
    <div class="page-header"><div>
      <h2 class="page-title">Knowledge sources</h2>
      <p class="page-sub">${d.sources.length} sources across ${cats.length} categories. Every artifact carries source, version, hash, and fetch time. Click a card to view provenance or sync now.</p>
    </div></div>
    <div class="filters" style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <select onchange="knowledgeFilter.category=this.value;renderResearch()"><option value="">All categories</option>${cats.map(c => `<option${c===knowledgeFilter.category?' selected':''}>${esc(c)}</option>`).join('')}</select>
      <select onchange="knowledgeFilter.tier=this.value;renderResearch()"><option value="">All tiers</option>${tiers.map(t => `<option${t===knowledgeFilter.tier?' selected':''}>${esc(t)}</option>`).join('')}</select>
      <select onchange="knowledgeFilter.domain=this.value;renderResearch()"><option value="">All domains</option>${doms.map(x => `<option${x===knowledgeFilter.domain?' selected':''}>${esc(x)}</option>`).join('')}</select>
      <button class="btn" onclick="runDueSources()">Run all due syncs</button>
    </div>
    ${Object.entries(grouped).map(([cat, srcs]) => `
      <h3 style="margin:20px 0 10px">${esc(cat)} <span class="pill muted">${srcs.length}</span></h3>
      <div class="knowledge-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
        ${srcs.map(s => sourceCard(s, reachMap[s.id])).join('')}
      </div>
    `).join('')}
    <div id="provenance-drawer" class="drawer" style="position:fixed;right:-560px;top:0;bottom:0;width:540px;background:var(--card);border-left:1px solid var(--border);padding:20px;overflow:auto;transition:right .2s;z-index:100;box-shadow:-4px 0 12px color-mix(in srgb, var(--recess) 8%, transparent)"></div>
  `;
}

export async function runDueSources() {
  const r = await api('POST', '/admin/knowledge/schedule/run-due', {});
  alert(`Ran ${r.results?.length ?? 0} due syncs`);
  renderResearch();
}

export async function saveCreds(id) {
  const fd = new FormData(document.getElementById('cred-form'));
  for (const [k, v] of fd.entries()) {
    await api('POST', `/admin/knowledge/credentials/${encodeURIComponent(id)}`, { key: k, value: String(v) });
  }
  const s = document.getElementById('cred-status'); s.textContent = 'Saved.';
}

export function sourceCard(s, reach) {
  const needs = (s.credentialsRequired || []).filter(f => f.required !== false);
  const setKeys = new Set(s.credentialsSet || []);
  const missing = needs.filter(f => !setKeys.has(f.name));
  const badge = needs.length === 0 ? '<span class="pill good">Public</span>' : missing.length === 0 ? '<span class="pill good">Credentials set</span>' : `<span class="pill bad">${missing.length} credential${missing.length>1?'s':''} needed</span>`;
  const packsPill = reach ? `<span class="pill muted" title="${(reach.packs||[]).join(', ')}">${reach.packs.length} pack${reach.packs.length!==1?'s':''}</span>` : '';
  const last = s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'never';
  return `<div class="card" style="padding:16px;border:1px solid var(--border);border-radius:8px">
    <div style="display:flex;justify-content:space-between;align-items:start;gap:8px"><strong>${esc(s.name)}</strong>${badge}</div>
    <div class="muted" style="font-size:12px;margin-top:4px"><code>${esc(s.id)}</code> · ${esc(s.publisher)} · ${esc(s.tier)} · cadence <code>${esc(s.cadence)}</code></div>
    <div class="muted" style="font-size:12px;margin-top:6px">${packsPill} · ${s.artifactCount} artifacts · last synced ${last}</div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
      ${needs.length > 0 ? `<button class="btn" onclick="openCredentialSheet('${esc(s.id)}')">Credentials</button>` : ''}
      <button class="btn primary" onclick="syncSource('${esc(s.id)}',this)">Sync now</button>
      <button class="btn" onclick="openProvenance('${esc(s.id)}')">Provenance</button>
    </div>
  </div>`;
}

export async function syncSource(id, btn) {
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Syncing…';
  try {
    const r = await api('POST', `/admin/knowledge/sync/${encodeURIComponent(id)}`, {});
    btn.textContent = r.ok ? `${r.summary.totalExtracted} artifacts` : 'Failed';
    if (r.ok) setTimeout(() => renderResearch(), 800);
  } catch (e) { btn.textContent = 'Error'; }
  setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 2500);
}

export async function testCreds(id, btn) {
  btn.disabled = true; const s = document.getElementById('cred-status'); s.textContent = 'Testing…';
  try { const r = await api('POST', `/admin/knowledge/test-credential/${encodeURIComponent(id)}`, {}); s.textContent = (r.ok ? '✓ ' : '✗ ') + (r.message || ''); }
  catch (e) { s.textContent = 'Test failed: ' + e.message; }
  btn.disabled = false;
}
