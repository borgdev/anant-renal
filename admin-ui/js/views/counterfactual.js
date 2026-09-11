import { api, consoleDomain } from '../core/api.js';
import { main } from '../core/shell.js';
import { dataGrid, esc } from '../core/theme.js';

export function cfReportHTML(report) {
  if (!report) return '<div class="muted">No report.</div>';
  const g = report.gates || {};
  const chip = (label, ok) => `<span class="pill ${ok ? 'good' : 'bad'}" title="${ok ? 'passed' : 'failed'}">${esc(label)}</span>`;
  const rows = (r) => [
    ['Patients', r.population?.patients ?? '—'],
    ['Mean Kt/V (primary)', r.population?.meanKtv != null ? Number(r.population.meanKtv).toFixed(3) : '—'],
    ['Max risk (worst patient)', r.population?.maxRisk != null ? Number(r.population.maxRisk).toFixed(3) : '—'],
    ['Max vitals instability', r.population?.maxVitals != null ? Number(r.population.maxVitals).toFixed(3) : '—'],
    ['Cost (USD)', r.cost?.totals?.totalUsd != null ? '$' + Number(r.cost.totals.totalUsd).toFixed(2) : '—'],
    ['Safety events', r.safety?.total ?? '—'],
    ['HITL pending', r.hitl?.pending ?? '—'],
  ];
  const table = (title, r) => `<div style="margin-bottom:10px;"><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">${title}</div>
    <table class="panel"><tbody>${rows(r).map(([k, v]) => `<tr><td style="width:60%;">${esc(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table></div>`;
  const d = report.delta || {};
  return `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
      <span class="pill ${report.promotable ? 'good' : 'warn'}">${report.promotable ? '✓ Promotable' : '✗ Not promotable'}</span>
      ${chip('Primary measure improves', g.measureImproves)}
      ${chip('No equity regression', g.noEquityRegression)}
      ${chip('No policy/safety violation', g.noPolicyViolation)}
    </div>
    ${(report.gateReasons || []).length ? `<div style="margin-bottom:10px;font-size:12px;color:var(--bad);">${report.gateReasons.map((r) => `• ${esc(r)}`).join('<br>')}</div>` : ''}
    <p style="font-size:13px;color:var(--fg);">${esc(report.interpretation || '')}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
      ${table('Baseline care', report.baseline)}
      ${table('With intervention', report.counterfactual)}
      <div><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">Delta</div>
        <table class="panel"><tbody>
          <tr><td>Cost</td><td>${d.dollars != null ? '$' + Number(d.dollars).toFixed(2) : '—'}</td></tr>
          <tr><td>Clinician minutes</td><td>${d.clinicianMin != null ? Number(d.clinicianMin).toFixed(0) : '—'}</td></tr>
          <tr><td>Safety risk</td><td>${d.safetyRisk != null ? Number(d.safetyRisk).toFixed(2) : '—'}</td></tr>
          <tr><td>Patient satisfaction</td><td>${d.patientSatisfaction != null ? Number(d.patientSatisfaction).toFixed(2) : '—'}</td></tr>
          <tr><td>Throughput</td><td>${d.throughput != null ? Number(d.throughput).toFixed(2) : '—'}</td></tr>
        </tbody></table></div>
    </div>`;
}

export async function loadCfList() {
  const el = document.getElementById('cf-list');
  if (!el) return;
  const d = await api('GET', '/admin/counterfactual').catch(() => ({ records: [] }));
  const recs = d.records || [];
  if (!recs.length) { el.innerHTML = '<div class="muted" style="font-size:13px;">No rehearsals yet — run one above.</div>'; return; }
  el.innerHTML = '';
  dataGrid({
    el: 'cf-list', stateKey: 'counterfactual-list', filename: 'counterfactual', pageSize: 8, empty: 'No rehearsals yet.',
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'label', label: 'Label', render: (v) => esc(v || 'ad-hoc') },
      { key: 'realmId', label: 'Realm', render: (v) => esc(v || '—') },
      { key: 'createdAt', label: 'Run at', render: (v) => esc(v ? v.slice(0, 16).replace('T', ' ') : '—') },
      { key: 'promotable', label: 'Verdict', render: (_v, r) => `<span class="pill ${r.report?.promotable ? 'good' : 'warn'}">${r.report?.promotable ? 'promotable' : 'not promotable'}</span>` },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<button class="btn btn-ghost" onclick="cfView('${esc(r.id)}')">View</button>${r.report?.promotable ? ` <button class="btn btn-primary" onclick="cfApply('${esc(r.id)}')">Apply with evidence</button>` : ''}` },
    ],
    data: recs,
  });
}

export async function renderCounterfactual() {
  const dom = await consoleDomain();
  const realms = await api('GET', '/admin/realms').catch(() => ({ realms: [] }));
  const realmOpts = (realms.realms || []).map((r) => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Counterfactual studio</h2>
      <p class="page-sub">Rehearse an intervention against a fresh twin of a population before it touches a real patient. A variant is promotable only if it improves the primary measure without equity regression or policy/safety violations.</p></div></div>
    <div class="section-card">
      <h3>New rehearsal</h3>
      <div class="field-row">
        <div class="field"><label>Source realm</label><select id="cf-realm">${realmOpts || '<option value="">no realms yet</option>'}</select></div>
        <div class="field"><label>Facility id</label><input id="cf-fac" value="${esc(dom.counterfactualDefault.facilityId)}" style="width:110px"></div>
        <div class="field"><label>Archetype</label><select id="cf-kind">${(dom.archetypes || []).map((a) => `<option>${esc(a.value)}</option>`).join('')}</select></div>
        <div class="field"><label>Units</label><input id="cf-units" value="${esc(dom.counterfactualDefault.units)}" style="width:130px"></div>
        <div class="field"><label>Patients</label><input id="cf-pt" type="number" value="${esc(dom.counterfactualDefault.patientCount)}" min="1" max="200" style="width:80px"></div>
        <div class="field"><label>Advance ticks</label><input id="cf-ticks" type="number" value="${esc(dom.counterfactualDefault.advanceTicks)}" min="0" style="width:80px"></div>
        <div class="field"><label>Label</label><input id="cf-label" placeholder="dietitian nudge v2" style="width:160px"></div>
      </div>
      <div class="field" style="margin-top:8px;"><label>Interventions (JSON)</label><textarea id="cf-interventions" rows="3" style="font-family:"JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px;">${esc(JSON.stringify(dom.counterfactualDefault.interventions))}</textarea></div>
      <div class="field-row" style="margin-top:8px;align-items:center;">
        <button class="btn btn-primary" id="cf-run"><i data-lucide="flask-conical"></i> Run rehearsal</button>
        <span class="muted" id="cf-status" style="font-size:12px;"></span>
      </div>
      <div id="cf-result" style="margin-top:12px;"></div>
    </div>
    <div class="section-card">
      <h3>Prior rehearsals</h3>
      <div id="cf-list"><div class="muted" style="font-size:13px;">Loading…</div></div>
    </div>`;
  document.getElementById('cf-run')?.addEventListener('click', async () => {
    const status = document.getElementById('cf-status');
    const out = document.getElementById('cf-result');
    let interventions = [];
    try { interventions = JSON.parse(document.getElementById('cf-interventions').value || '[]'); }
    catch { status.textContent = 'Interventions JSON is invalid.'; return; }
    const units = document.getElementById('cf-units').value.split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      realmId: document.getElementById('cf-realm').value,
      facility: {
        facilityId: document.getElementById('cf-fac').value || dom.counterfactualDefault.facilityId,
        kind: document.getElementById('cf-kind').value,
        name: document.getElementById('cf-kind').value,
        units,
        patientCount: Math.max(1, Math.min(200, Number(document.getElementById('cf-pt').value || 12))),
      },
      interventions,
      advanceTicks: Math.max(0, Number(document.getElementById('cf-ticks').value || 0)),
      ...(document.getElementById('cf-label').value ? { label: document.getElementById('cf-label').value } : {}),
    };
    status.textContent = 'Running rehearsal…';
    try {
      const res = await fetch('/admin/counterfactual/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      status.textContent = `Done — ${j.id} · ${j.report?.promotable ? 'promotable' : 'not promotable'}`;
      out.innerHTML = cfReportHTML(j.report);
      loadCfList();
    } catch (err) { status.textContent = ''; out.innerHTML = `<div class="state-card error"><div class="state-title">Rehearsal failed</div><div class="state-sub">${esc(String(err))}</div></div>`; }
  });
  loadCfList();
}
