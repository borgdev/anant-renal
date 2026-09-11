import { S } from '../state.js';
import { api } from '../core/api.js';
import { emptyStateHTML, errorStateHTML, loadingHTML, mountScope, scopeShell, setScopeHint } from '../core/scope.js';
import { main } from '../core/shell.js';
import { copyToClipboard, dataGrid, downloadBlob, esc } from '../core/theme.js';

export function closeRealmModal() { const m = document.getElementById('rm-modal'); if (m) m.classList.remove('open'); }

export function createModalHTML() {
  return `<div class="modal-overlay" id="rm-modal">
    <div class="modal">
      <div class="modal-header"><h3>Create a realm</h3><button class="modal-close" id="rm-modal-close" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="field-grid">
          <label class="field"><span>Realm id</span><input id="rm-id" value="realm:dialysis-1"></label>
          <label class="field"><span>Archetype</span><select id="rm-arch">${(S.dom.archetypes || []).map((a) => `<option value="${esc(a.value)}">${esc(a.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Units (comma-sep)</span><input id="rm-units" value="${esc(S.dom.domainOptions.unitsDefault)}"></label>
          <label class="field"><span>Patients</span><input id="rm-pt" type="number" value="8" min="1"></label>
          <label class="field"><span>Clock</span><select id="rm-clock"><option value="sim">Sim (accelerated)</option><option value="twin">Twin (wall clock)</option></select></label>
          <label class="field"><span>Trajectory AI</span><select id="rm-engine"><option value="liquid">Liquid (Anant)</option><option value="legacy">Legacy</option></select></label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" id="rm-modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="rm-create"><i data-lucide="plus"></i> Create realm</button>
      </div>
    </div>
  </div>`;
}

export function fmtEffect(e) {
  const kind = e.kind;
  switch (kind) {
    case 'admit-patient': return `admit <code>${esc(e.patientId)}</code> to <code>${esc(e.unitId)}</code>`;
    case 'transfer-patient': return `transfer <code>${esc(e.patientId)}</code> to <code>${esc(e.toUnitId)}</code>`;
    case 'discharge-patient': return `discharge <code>${esc(e.patientId)}</code>`;
    case 'order-lab': return `order <code>${esc(e.code)}</code> lab for <code>${esc(e.patientId)}</code> (${esc(e.priority)})`;
    case 'result-lab': return `result <code>${esc(e.code)}</code>=${esc(String(e.value))} ${esc(e.unit)}${e.abnormal ? ` <span class="pill bad">${esc(e.abnormal)}</span>` : ''}`;
    case 'order-med': return `order <code>${esc(e.code)}</code> ${esc(e.dose)} ${esc(e.route)} ${esc(e.frequency)} for <code>${esc(e.patientId)}</code>`;
    case 'hold-med': return `hold med <code>${esc(e.medOrderId)}</code> — ${esc(e.reason)}`;
    case 'record-vitals': return `vitals for <code>${esc(e.patientId)}</code>: HR ${e.hr ?? '—'} BP ${esc(e.bp || '—')} SpO₂ ${e.spo2 ?? '—'}`;
    case 'record-assessment': return `assessment <code>${esc(e.assessmentId)}</code> score ${e.score}${e.band ? ` (${esc(e.band)})` : ''} for <code>${esc(e.patientId)}</code>`;
    case 'submit-claim': return `claim for encounter <code>${esc(e.encounterId)}</code> → ${esc(e.payerId)} · CPT ${(e.cptCodes || []).join(',')}`;
    case 'notify-staff': return `notify ${esc(e.role)}: ${esc(e.message)}`;
    case 'record-agent-thought': return `<span class="muted">thought:</span> “${esc(e.note)}”`;
    default: return `<code>${esc(kind)}</code> ${esc(JSON.stringify(e).slice(0, 120))}`;
  }
}

export function openRealmModal() { const m = document.getElementById('rm-modal'); if (m) m.classList.add('open'); }

export function realmCard(r) {
  return `<div class="rm-card ${r.id === S.realmSel ? 'active' : ''}" data-id="${esc(r.id)}">
    <div class="rm-card-top"><code>${esc(r.id)}</code><span class="pill ${r.trajectoryEngine === 'liquid' ? 'brand' : 'muted'}">${r.trajectoryEngine === 'liquid' ? 'Anant' : 'legacy'}</span></div>
    <div class="rm-card-meta">${r.counts?.patient || 0} patients · ${r.presences || 0} presences · ${r.effects || 0} effects</div>
    <div class="rm-card-time muted">${r.realmAt ? new Date(r.realmAt).toLocaleString() : ''}</div>
  </div>`;
}

export async function renderEffects() {
  main.innerHTML = scopeShell('Effect ledger', 'Append-only log of every world effect. Immutable; reversal requires a compensating effect.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const r = await api('GET', `/admin/realms/${encodeURIComponent(realmId)}/effects`);
      const rows = r.effects || [];
      setScopeHint(`${rows.length} effect${rows.length === 1 ? '' : 's'}`);
      if (!rows.length) { body.innerHTML = emptyStateHTML('No effects recorded', 'Tick the clock or emit an effect from World → Realm → “Emit effect”.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML = '<div id="scope-grid"></div>';
      dataGrid({
        el: 'scope-grid', stateKey: 'effects-scope', filename: 'effects', pageSize: 25, empty: 'No effects recorded yet.',
        selectable: true, idKey: 'id',
        bulkActions: [
          { label: 'Export selected JSON', onClick(rows) { downloadBlob('effects-selected.json', 'application/json', JSON.stringify(rows, null, 2)); } },
          { label: 'Copy IDs', onClick(rows) { copyToClipboard(rows.map((r) => r.id || '').filter(Boolean).join('\n')); } },
        ],
        columns: [
          { key: 'realmAt', label: 'Realm time', render: (v) => `<span class="muted" style="font-size:12px;">${v ? new Date(v).toLocaleString() : '—'}</span>` },
          { key: 'agentSpecId', label: 'Agent', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'status', label: 'Status', render: (v) => `<span class="pill ${v === 'bound' ? 'good' : v === 'rejected' ? 'bad' : 'muted'}">${esc(v)}</span>` },
          { key: 'effect', label: 'Effect', render: (_v, e) => fmtEffect(e.effect) },
        ],
        data: rows,
      });
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}

export async function renderPerception() {
  main.innerHTML = scopeShell('Perception log', 'Events delivered to presences (governance + locality filtered).');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const [snap, per] = await Promise.all([
        api('GET', `/admin/realms/${encodeURIComponent(realmId)}`),
        api('GET', `/admin/realms/${encodeURIComponent(realmId)}/perception`),
      ]);
      const rows = (per.events || []).slice(-100).reverse();
      const presences = snap.presences || [];
      const nameFor = (pid) => presences.find((p) => p.presenceId === pid)?.agentSpecId || (pid || '').slice(0, 8) || '—';
      setScopeHint(`${rows.length} recent events`);
      if (!rows.length) { body.innerHTML = emptyStateHTML('No perception events yet', 'Spawn presences and let the realm run — delivered events will stream in here.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML = '<div id="scope-grid"></div>';
      dataGrid({
        el: 'scope-grid', stateKey: 'perception-scope', filename: 'perception', pageSize: 25, empty: 'No perception events yet.',
        columns: [
          { key: 'realmAt', label: 'At', render: (v) => `<span class="muted" style="font-size:12px;">${v ? new Date(v).toLocaleTimeString() : '—'}</span>` },
          { key: 'agent', label: 'Perceived by', render: (_v, e) => `<code>${esc(nameFor(e.presenceId))}</code>` },
          { key: 'kind', label: 'Kind', render: (v) => `<span class="pill">${esc(v)}</span>` },
          { key: 'entityUrn', label: 'Entity', render: (v) => `<span class="muted" style="font-size:11px;">${esc((v || '').split(':').slice(-2).join(':'))}</span>` },
          { key: 'payload', label: 'Payload', render: (v) => `<span class="muted" style="font-size:12px;">${esc(JSON.stringify(v).slice(0, 140))}</span>` },
        ],
        data: rows,
      });
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}

export async function renderPresences() {
  main.innerHTML = scopeShell('Presences', 'Every agent has a body in the realm. Presence determines perception and effect authority.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const r = await api('GET', `/admin/realms/${encodeURIComponent(realmId)}`);
      const rows = r.presences || [];
      setScopeHint(`${rows.length} presence${rows.length === 1 ? '' : 's'}`);
      if (!rows.length) { body.innerHTML = emptyStateHTML('No presences yet', 'Spawn an agent presence from World → Realm → “Spawn presence” and it will appear here.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML = '<div id="scope-grid"></div>';
      dataGrid({
        el: 'scope-grid', stateKey: 'presences-scope', filename: 'presences', empty: 'No presences in this realm.',
        columns: [
          { key: 'agentSpecId', label: 'Agent', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'role', label: 'Role', render: (v) => `<span class="pill">${esc(v)}</span>` },
          { key: 'facility', label: 'Facility', render: (_v, p) => esc(p.location?.facilityId || '—') },
          { key: 'unit', label: 'Unit', render: (_v, p) => esc(p.location?.unitId || '—') },
          { key: 'range', label: 'Perceptual range', render: (_v, p) => `<span class="muted" style="font-size:12px;">units: ${(p.perceptualRange?.units || []).join(',')} · pts: ${(p.perceptualRange?.patients || []).slice(0, 3).join(',')}${(p.perceptualRange?.patients || []).length > 3 ? '…' : ''}</span>` },
          { key: 'attention', label: 'Attention', render: (v) => `<span class="pill ${v === 'active' ? 'good' : 'muted'}">${esc(v)}</span>` },
        ],
        data: rows,
      });
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}

export const trajPill = (t) => `<span class="pill ${t==='decompensating'||t==='anemic-worsening'||t==='hyperphosphatemia'||t==='underdialyzed'?'bad':t==='stable'?'good':'muted'}">${esc(t)}</span>`;
