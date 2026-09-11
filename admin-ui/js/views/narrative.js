import { S } from '../state.js';
import { api, auditLog, consoleDomain } from '../core/api.js';
import { main } from '../core/shell.js';
import { copyToClipboard, dataGrid, downloadBlob, esc } from '../core/theme.js';

export async function renderAudit() {
  let entries = null;
  try {
    const res = await fetch('/admin/audit-log', { headers: { accept: 'application/json' } });
    if (res.ok) { const j = await res.json(); entries = Array.isArray(j.entries) ? j.entries : null; }
  } catch { /* offline */ }
  const list = entries !== null ? entries : auditLog;
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Authoring audit log</h2><p class="page-sub">Every draft/publish/reject action is recorded with actor and content hash${entries !== null ? ' (authoring service audit chain).' : '.'} Select rows for bulk export.</p></div></div>
    <div id="audit-grid"></div>`;
  dataGrid({
    el: 'audit-grid', filename: 'audit', pageSize: 25, empty: 'No actions yet.',
    selectable: true, idKey: 'timestamp',
    bulkActions: [
      { label: 'Export selected JSON', onClick(rows) { downloadBlob('audit-selected.json', 'application/json', JSON.stringify(rows, null, 2)); } },
      { label: 'Copy IDs', onClick(rows) { copyToClipboard(rows.map((r) => r.id || '').filter(Boolean).join('\n')); } },
    ],
    columns: [
      { key: 'timestamp', label: 'Timestamp', render: (v) => `<span class="muted">${v ? new Date(v).toLocaleString() : '—'}</span>` },
      { key: 'actorRef', label: 'Actor', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'action', label: 'Action', render: (v) => `<span class="pill ${v==='publish'?'good':v==='reject'||v==='delete'?'bad':'muted'}">${esc(v)}</span>` },
      { key: 'packId', label: 'Pack' },
      { key: 'agentId', label: 'Agent', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'contentSha256', label: 'Hash', render: (v) => `<code style="font-size:11px;">${esc((v||'').slice(0,12))}</code>` },
      { key: 'note', label: 'Note' },
    ],
    data: list.map((e) => ({ ...e, timestamp: e.timestamp || new Date().toISOString() })),
  });
}

export function renderForecastChart(el, points) {
  const W = 720, H = 180, pad = 34;
  const series = [
    { key: 'ktv_adequacy', color: '#1baf7a', label: 'Kt/V' },
    { key: 'deterioration_risk', color: '#e87ba4', label: 'Risk' },
    { key: 'phosphate', color: '#eb6834', label: 'Phos' },
  ];
  const n = points.length;
  const x = i => pad + (i / Math.max(n - 1, 1)) * (W - pad * 2);
  const y = v => H - pad - v * (H - pad * 2);
  const path = s => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.state[s.key]).toFixed(1)}`).join(' ');
  const last = points[points.length - 1] || {};
  el.innerHTML = `
    <div class="cards" style="grid-template-columns: repeat(4,1fr); margin-bottom:12px;">
      <div class="stat-card"><div class="num">${last.labs?.K ?? '—'}</div><div class="lbl">K (mmol/L)</div></div>
      <div class="stat-card"><div class="num">${last.labs?.URR ?? '—'}</div><div class="lbl">URR %</div></div>
      <div class="stat-card"><div class="num">${last.labs?.PHOS ?? '—'}</div><div class="lbl">Phos (mg/dL)</div></div>
      <div class="stat-card"><div class="num">${last.risk ?? '—'}</div><div class="lbl">Deterioration risk</div></div>
    </div>
    <div class="table-wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">
      ${series.map(s => `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2"/>`).join('')}
      ${series.map(s => `<text x="${W - pad}" y="${y(points[0]?.state[s.key] ?? 0)}" fill="${s.color}" font-size="11" text-anchor="end">${s.label}</text>`).join('')}
    </svg></div>
    <p class="detail muted" style="margin-top:8px;">Forecast over ${(last.t ?? 0).toFixed(0)} realm-hours · computed locally · baseline care until a trained model is activated.</p>`;
}

export async function renderLiquidTrain() {
  const [models, cmp] = await Promise.all([
    api('GET', '/admin/liquid/models'),
    api('GET', '/admin/liquid/compare'),
  ]);
  const active = models.active || [];
  const history = models.history || [];
  const modelLabel = (k) => k === 'cfc' ? 'Adaptive (CfC)' : k === 'ltc' ? 'Anant State (LTC)' : (k || '—');
  const cmpRows = [
    ['Baseline care (no AI)', cmp.baselineMae ?? '—'],
    ['Adaptive model (CfC)', cmp.cfc ? cmp.cfc.trainedMae : 'not trained'],
    ['Anant State model (LTC)', cmp.ltc ? cmp.ltc.trainedMae : 'not trained'],
  ];
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Model training</h2>
      <p class="page-sub">Train the trajectory AI on your dialysis population, compare against baseline care, and activate the best variant — new realms use it automatically.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(3,1fr);">
      <div class="stat-card"><div class="num">${modelLabel(active[0]?.modelKind)}</div><div class="lbl">Active model</div></div>
      <div class="stat-card"><div class="num">${active[0]?.modelId ?? '—'}</div><div class="lbl">Active model id</div></div>
      <div class="stat-card"><div class="num">${history.length}</div><div class="lbl">Trained models</div></div>
    </div>
    <div class="table-wrap" style="margin-bottom:16px;"><table>
      <thead><tr><th>Model variant</th><th>Forecast error (lower is better)</th></tr></thead>
      <tbody>${cmpRows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="detail" style="margin-top:0;"><div class="field-row">
      <label class="field"><span>Training rounds</span><input id="lt-epochs" type="number" value="10" style="width:90px"></label>
      <label class="field"><span>Patient samples</span><input id="lt-sequences" type="number" value="12" style="width:90px"></label>
      <button class="btn primary" id="lt-train-cfc"><i data-lucide="cpu"></i> Train adaptive</button>
      <button class="btn" id="lt-train-ltc"><i data-lucide="cpu"></i> Train Anant State</button>
    </div></div>
    <pre id="lt-out" class="detail" style="background:var(--code-bg);color:var(--code-fg);padding:12px;border-radius:8px;white-space:pre-wrap;"></pre>`;
  const run = async (kind) => {
    const out = document.getElementById('lt-out');
    out.textContent = `Training ${kind.toUpperCase()}… (server-side, may take a minute)`;
    try {
      const res = await fetch('/admin/liquid/train', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelKind: kind, epochs: Number(document.getElementById('lt-epochs').value || 10), numSequences: Number(document.getElementById('lt-sequences').value || 12) }) });
      const d = await res.json();
      if (!res.ok) { out.textContent = 'error: ' + JSON.stringify(d); return; }
      out.textContent = JSON.stringify({ run: d.run, active: d.active }, null, 2);
      renderLiquidTrain();
    } catch (err) { out.textContent = 'error: ' + String(err); }
  };
  document.getElementById('lt-train-cfc')?.addEventListener('click', () => run('cfc'));
  document.getElementById('lt-train-ltc')?.addEventListener('click', () => run('ltc'));
}

export async function renderLiquidWhatIf() {
  let realms = [];
  try { realms = (await api('GET', '/admin/realms')).realms || []; } catch (_) {}
  const dom = await consoleDomain();
  const realmOptions = realms.map(r => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">What-If forecast</h2>
      <p class="page-sub">Project a patient's dialysis trajectory under an intervention — computed locally by the embedded Anant engine, zero network round-trip for the forecast.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));">
      <label class="detail">Realm<br><select id="wi-realm">${realmOptions || '<option value="">(no realms yet)</option>'}</select></label>
      <label class="detail">Patient<br><select id="wi-patient"></select></label>
      <label class="detail">Intervention<br><select id="wi-intervention">
        <option value="[]">None</option>
        ${(dom.whatIfPresets || []).map((p) => `<option value='${JSON.stringify(p.effects).replace(/'/g, '&#39;')}'>${esc(p.label)}</option>`).join('')}
      </select></label>
      <label class="detail">Horizon (h)<br><input id="wi-steps" type="number" value="72" style="width:70px"></label>
      <div style="align-self:end"><button class="btn primary" id="wi-run"><i data-lucide="play"></i> Run forecast</button></div>
    </div>
    <div id="wi-out" class="detail muted" style="padding:20px;">Pick a realm, then a patient.</div>`;
  const realmSel = document.getElementById('wi-realm');
  const patientSel = document.getElementById('wi-patient');
  async function loadPatients() {
    const rid = realmSel.value;
    if (!rid) { patientSel.innerHTML = '<option value="">(no realms yet)</option>'; return; }
    try {
      const d = await api('GET', `/admin/realms/${rid}/patients`);
      patientSel.innerHTML = (d.patients || []).map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('') || '<option value="">(no patients)</option>';
    } catch (_) { patientSel.innerHTML = '<option value="">(no patients)</option>'; }
  }
  realmSel.addEventListener('change', loadPatients);
  // Cross-page deep link from Realm → What-If: pre-select the realm + patient.
  if (S.wiDeepLink) {
    const dl = S.wiDeepLink; S.wiDeepLink = null;
    if (dl.realmId && realms.some(r => r.id === dl.realmId)) {
      realmSel.value = dl.realmId;
      await loadPatients();
      if (dl.patientId) patientSel.value = dl.patientId;
    }
  }
  document.getElementById('wi-run')?.addEventListener('click', async () => {
    const rid = realmSel.value, pid = patientSel.value;
    if (!rid || !pid) return;
    const out = document.getElementById('wi-out');
    out.innerHTML = '<div class="muted">Running local forecast…</div>';
    try {
      const d = await api('GET', `/admin/realms/${rid}/patients`);
      const patient = (d.patients || []).find(p => p.id === pid);
      const fromState = patient?.state?.liquid?.state || {};
      const steps = Number(document.getElementById('wi-steps').value || 72);
      const intervention = JSON.parse(document.getElementById('wi-intervention').value);
      const points = await window.__liquidForecast(fromState, steps, intervention);
      renderForecastChart(out, points);
    } catch (err) { out.innerHTML = `<div class="bad">forecast failed: ${esc(String(err))}</div>`; }
  });
  loadPatients();
}
