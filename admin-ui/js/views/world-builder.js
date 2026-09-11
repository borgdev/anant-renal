import { api, consoleDomain } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc, toast } from '../core/theme.js';

export async function renderWorldBuilder() {
  const dom = await consoleDomain();
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Build a world</h2><p class="page-sub">Every world is governed by its own rules, materialized as experiences for agents. This wizard configures a realm you can spawn agents into.</p></div></div>
    <div class="detail" style="max-width:820px;">
      <div style="display:grid;grid-template-columns:180px 1fr;gap:16px 20px;align-items:center;">
        <label>Realm id</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input id="wb-id" value="" placeholder="Search an existing realm or type a new id…" list="wb-realm-list" style="flex:1;min-width:0;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);"/>
          <datalist id="wb-realm-list"></datalist>
        </div>
        <label>Archetype</label>
        <select id="wb-arch" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);">
          ${(dom.archetypes || []).map((a) => `<option value="${esc(a.value)}">${esc(a.label)}</option>`).join('')}
        </select>
        <label>Units</label><input id="wb-units" value="${esc(dom.domainOptions.unitsDefault)}" placeholder="comma separated" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);"/>
        <label>Patients</label><input id="wb-pt" type="number" value="${esc(dom.domainOptions.patientCountDefault)}" min="1" max="200" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);"/>
        <label>Clock</label>
        <select id="wb-clock" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);">
          <option value="sim">Sim (accelerated — 1hr / 50ms)</option>
          <option value="twin">Twin (wall clock)</option>
        </select>
        <label>Staff packs</label>
        <div>
          ${(dom.staffPacks || []).map((p) => `<label style="display:block;"><input type="checkbox" ${p.checked ? 'checked' : ''} id="${esc(p.id)}"/> ${esc(p.label)}</label>`).join('')}
        </div>
        <label>Rules</label>
        <div class="muted" style="font-size:12px;line-height:1.5;">Default YAML rules (hyperkalemia, ready-to-bill) and TS rules (insurance-expiring) are registered automatically on every realm.</div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button class="btn primary" onclick="wbSubmit()">Create realm</button>
        <button class="btn" onclick="nav.querySelector('[data-view=realm]').click()">Cancel</button>
      </div>
      <div id="wb-out" style="margin-top:16px;font-family:ui-monospace,monospace;font-size:12px;color:var(--muted);"></div>
    </div>
  `;
  // Populate the searchable realm dropdown (search an existing realm).
  try {
    const r = await api('GET', '/admin/realms');
    const dl = document.getElementById('wb-realm-list');
    if (dl) dl.innerHTML = (r.realms || []).map(x => `<option value="${esc(x.id)}"></option>`).join('');
  } catch (_) { /* live list unavailable */ }
}

export async function spawnStaff(realmId) {
  const units = (document.getElementById('wb-units')?.value || 'ICH-A').split(',').map((s) => s.trim()).filter(Boolean);
  const first = units[0] || 'ICH-A';
  const packs = (await consoleDomain()).staffPacks || [];
  const wanted = [];
  for (const p of packs) {
    if (!document.getElementById(p.id)?.checked) continue;
    if (p.agentSpecId === 'nurse') units.forEach((u) => wanted.push({ agentSpecId: 'nurse', role: 'nurse', unitId: u }));
    else wanted.push({ agentSpecId: p.agentSpecId, role: p.agentSpecId, unitId: first });
  }
  let spawned = 0;
  for (const p of wanted) {
    try {
      const res = await fetch(`/admin/realms/${encodeURIComponent(realmId)}/presences`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentSpecId: p.agentSpecId, role: p.role, clearance: 'phi', facilityId: 'f1', unitId: p.unitId }) });
      if (res.ok) spawned++;
    } catch (_) { /* best-effort */ }
  }
  if (spawned) toast(`Spawned ${spawned} staff presence${spawned === 1 ? '' : 's'} in ${realmId}`, 'good');
}
