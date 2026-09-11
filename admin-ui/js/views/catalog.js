import { api } from '../core/api.js';
import { currentYearPeriod } from '../core/format.js';
import { main } from '../core/shell.js';
import { dataGrid, esc, hydrateIcons, toast } from '../core/theme.js';

export function labPatientBundle(patient) {
  const now = new Date().toISOString();
  const L = patient.labs || {};
  const obs = (code, display, value, unit) => ({ resourceType: 'Observation', id: `${patient.id}-${code}`, status: 'final', subject: { reference: `Patient/${patient.id}` }, effectiveDateTime: now, code: { coding: [{ system: 'http://loinc.org', code, display }] }, valueQuantity: { value, unit } });
  const resources = [
    { resourceType: 'Patient', id: patient.id },
    obs('2823-3', 'Potassium', L.K, 'mmol/L'),
    obs('718-7', 'Hemoglobin', L.HGB, 'g/dL'),
    obs('48151-2', 'Urea reduction ratio', L.URR, '%'),
    obs('14879-1', 'Phosphate [Mass/volume] in Serum or Plasma', L.PHOS, 'mg/dL'),
    // extra labs so embedded catalog measures (hypercalcemia, Kt/V adequacy) are demoable
    obs('17861-6', 'Calcium [Mass/volume] in Serum or Plasma', L.Ca ?? 11.0, 'mg/dL'),
    obs('18262-6', 'Kt/V (single pool)', L.KtV ?? 1.4, 'Kt/V'),
  ];
  if (patient.hypertension) resources.push({ resourceType: 'Condition', id: `${patient.id}-htn`, subject: { reference: `Patient/${patient.id}` }, code: { coding: [{ system: 'http://snomed.info/sct', code: '59621000', display: 'Essential hypertension (disorder)' }] }, onsetDateTime: now });
  return { resourceType: 'Bundle', type: 'collection', entry: resources.map((resource) => ({ resource })) };
}

export async function renderAssessments() {
  const d = await api('GET', '/admin/assessments');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Validated assessments</h2><p class="page-sub">Screeners and scales included with LOINC codes, scoring bands, and provenance.</p></div></div>
    <div id="assessments-grid"></div>
  `;
  dataGrid({
    el: 'assessments-grid', filename: 'assessments', pageSize: 25, empty: 'No assessments found.',
    columns: [
      { key: 'id', label: 'ID', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'title', label: 'Title' },
      { key: 'loinc', label: 'LOINC', render: (v) => v ? `<code>${esc(v)}</code>` : '—' },
      { key: 'domain', label: 'Domain', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
      { key: 'itemCount', label: 'Items', align: 'right' },
    ],
    data: d.assessments,
  });
}

export async function renderLifecycle() {
  // Diagrammatic persona lifecycle. Reads the lifecycle graph baked into the
  // realm snapshot (nodes, edges, cohort counts). Falls back to the plain
  // stages list if the realm isn't bundled.
  const r = await api('GET', '/admin/realms/demo');
  const stages = (await api('GET', '/admin/lifecycle')).stages;
  const g = r?.lifecycle;
  if (!g) {
    main.innerHTML = `<div class="page-header"><div><h2 class="page-title">Persona lifecycle</h2><p class="page-sub">${stages.length} canonical stages.</p></div></div><div id="lifecycle-grid"></div>`;
    dataGrid({
      el: 'lifecycle-grid', filename: 'lifecycle', empty: 'No stages defined.',
      columns: [
        { key: 'order', label: '#', align: 'right' },
        { key: 'id', label: 'ID', render: (v) => `<code>${esc(v)}</code>` },
      ],
      data: stages.map((s, i) => ({ ...s, order: i + 1 })),
    });
    return;
  }
  const columns = { entry: 0, process: 1, risk: 2, good: 2, 'exit-good': 3, exit: 3, 'exit-bad': 3 };
  const colors = { entry: '#38bdf8', process: '#6366f1', risk: '#f59e0b', good: '#22c55e', 'exit-good': '#22c55e', exit: '#94a3b8', 'exit-bad': '#ef4444' };
  const phaseMeta = [
    { title: 'Entry', sub: 'referral → onboarded', kind: 'entry' },
    { title: 'Care', sub: 'active care', kind: 'process' },
    { title: 'Risk / Stable', sub: 'decompensating · hospitalized · stable', kind: 'risk' },
    { title: 'Exit', sub: 'transplant · discharged · mortality', kind: 'exit' },
  ];
  const cohort = g.cohorts ?? {};
  const totalCohort = Object.values(cohort).reduce((a, b) => a + b, 0);

  // ---- Layout: 4 columns of card "phases", auto-sized so nothing clips ----
  const perCol = {};
  g.nodes.forEach(n => { const c = columns[n.kind] ?? 1; (perCol[c] ??= []).push(n); });
  const colKeys = [...new Set(g.nodes.map(n => columns[n.kind] ?? 1))].sort((a, b) => a - b);
  const numCols = Math.max(colKeys.length, 1);
  const cardW = 164, cardH = 64, halfW = cardW / 2, halfH = cardH / 2, colW = 212, vGap = 28, M = 34, headerH = 56;
  const firstTop = headerH + 20;
  let maxColH = 0;
  Object.values(perCol).forEach(arr => { maxColH = Math.max(maxColH, arr.length * (cardH + vGap) - vGap); });
  const contentW = M * 2 + numCols * colW;
  const contentH = firstTop + maxColH + 24;
  const laid = {};
  Object.entries(perCol).forEach(([col, arr]) => {
    arr.forEach((n, i) => {
      laid[n.id] = { x: M + Number(col) * colW + colW / 2, y: firstTop + cardH / 2 + i * (cardH + vGap), node: n };
    });
  });

  // ---- Edge geometry: anchor on card edges, smooth bezier, arrowheads ----
  const anchors = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) > Math.abs(dy)) return { x1: a.x + (dx >= 0 ? halfW : -halfW), y1: a.y, x2: b.x + (dx >= 0 ? -halfW : halfW), y2: b.y };
    return { x1: a.x, y1: a.y + (dy >= 0 ? halfH : -halfH), x2: b.x, y2: b.y + (dy >= 0 ? -halfH : halfH) };
  };
  const edgePath = (a, b) => {
    const { x1, y1, x2, y2 } = anchors(a, b);
    const dx = x2 - x1;
    const c = Math.max(46, Math.min(160, Math.abs(dx) * 0.6));
    const cx1 = x1 + (dx >= 0 ? c : -c), cx2 = x2 + (dx >= 0 ? -c : c);
    return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
  };
  const markerDefs = [...new Set(Object.values(colors))].map(c =>
    `<marker id="lc-arr-${c.slice(1)}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${c}"/></marker>`).join('');
  const edgesSvg = g.edges.map(e => {
    const a = laid[e.from], b = laid[e.to]; if (!a || !b) return '';
    const color = colors[b.node.kind] ?? '#8898b5';
    const w = 1 + Math.min(4.5, Math.max(1, (cohort[e.from] ?? 0) / 2));
    return `<path d="${edgePath(a, b)}" stroke="${color}" stroke-opacity="0.5" stroke-width="${w}" fill="none" marker-end="url(#lc-arr-${color.slice(1)})"/>`;
  }).join('');

  // ---- Column phase bands + headers (with cohort totals) ----
  const bandsSvg = colKeys.map(col => {
    const meta = phaseMeta[col] || { title: `Phase ${col + 1}`, kind: 'process' };
    const color = colors[meta.kind] || '#8898b5';
    const nodesIn = perCol[col] || [];
    const tot = nodesIn.reduce((s, n) => s + (cohort[n.id] ?? 0), 0);
    const share = totalCohort ? Math.round((tot / totalCohort) * 100) : 0;
    const cx = M + col * colW + colW / 2;
    return `<g>
      <rect x="${M + col * colW + 8}" y="${headerH - 2}" width="${colW - 16}" height="${contentH - headerH + 2}" rx="14" fill="${color}" fill-opacity="0.05"/>
      <text x="${cx}" y="22" text-anchor="middle" style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;fill:${color}">${esc(meta.title)}</text>
      <text x="${cx}" y="40" text-anchor="middle" style="font-size:11px;fill:var(--muted)">${tot} patients · ${share}% of cohort · ${esc(meta.sub)}</text>
    </g>`;
  }).join('');

  // ---- Nodes as cards: count badge + wrapped label + share ----
  const wrap2 = (s, max) => {
    const words = String(s).split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (t.length > max && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    return lines.slice(0, 2);
  };
  const nodesSvg = Object.values(laid).map(({ x, y, node }) => {
    const count = cohort[node.id] ?? 0;
    const pct = totalCohort ? Math.round((count / totalCohort) * 100) : 0;
    const color = colors[node.kind] ?? '#8898b5';
    const lines = wrap2(node.label, 15);
    const startY = lines.length === 2 ? -6 : 4;
    const labelTs = lines.map((ln, i) => `<tspan x="-24" dy="${i === 0 ? startY : 14}">${esc(ln)}</tspan>`).join('');
    const pctY = startY + lines.length * 14;
    return `<g class="lc-card" transform="translate(${x} ${y})">
      <title>${esc(node.label)} — ${count} patient${count === 1 ? '' : 's'} (${pct}% of cohort)</title>
      <rect x="${-halfW}" y="${-halfH}" width="${cardW}" height="${cardH}" rx="14" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1.5"/>
      <circle cx="${-52}" cy="0" r="19" fill="${color}"/>
      <text x="${-52}" y="4" text-anchor="middle" style="font-size:13px;font-weight:700;fill:#fff">${count}</text>
      <text x="${-24}" text-anchor="start" style="font-size:12.5px;font-weight:600;fill:var(--fg)">${labelTs}</text>
      <text x="${-24}" y="${pctY}" text-anchor="start" style="font-size:10.5px;fill:var(--muted)">${pct}% of cohort</text>
    </g>`;
  }).join('');

  // ---- Stat chips ----
  const stat = (lbl, val, color) => `<div class="lc-stat"><div class="lc-stat-num" style="color:${color}">${val}</div><div class="lc-stat-lbl">${lbl}</div></div>`;
  const riskN = (cohort.decompensating ?? 0) + (cohort.hospitalized ?? 0);
  const exitsN = (cohort.transplant ?? 0) + (cohort.discharged ?? 0) + (cohort.mortality ?? 0);

  // ---- Legend ----
  const legend = [...new Set(g.nodes.map(n => n.kind))].map(k =>
    `<span class="lc-chip"><span class="lc-dot" style="background:${colors[k] ?? '#8898b5'}"></span>${esc(k.replace(/-/g, ' '))}</span>`).join('');

  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Persona lifecycle</h2><p class="page-sub">${totalCohort} patients across ${g.nodes.length} stages — node cards show current cohort, edges show flow direction and magnitude. Scroll or zoom to explore; it always fits the viewport.</p></div></div>
    <div class="lc-stats">
      ${stat('Total cohort', totalCohort, 'var(--fg)')}
      ${stat('In active care', cohort.active ?? 0, colors.process)}
      ${stat('Risk (decomp / hospitalized)', riskN, colors.risk)}
      ${stat('Stable', cohort.stable ?? 0, colors.good)}
      ${stat('Exits', exitsN, colors.exit)}
    </div>
    <div class="detail" style="margin-top:0;">
      <div class="lc-wrap" id="lc-wrap">
        <div class="lc-toolbar">
          <span class="lc-hint">Scroll to pan · buttons to zoom · hover a card for details</span>
          <div class="lc-tools">
            <button class="lc-btn" id="lc-fit" title="Fit to viewport">Fit</button>
            <button class="lc-btn" id="lc-out" title="Zoom out">−</button>
            <button class="lc-btn" id="lc-in" title="Zoom in">+</button>
            <button class="lc-btn" id="lc-100" title="Actual size">100%</button>
          </div>
        </div>
        <svg id="lc-svg" viewBox="0 0 ${contentW} ${contentH}" style="display:block;background:var(--card);">
          <defs>${markerDefs}</defs>
          ${bandsSvg}
          ${edgesSvg}
          ${nodesSvg}
        </svg>
      </div>
      <div class="lc-legend">${legend}</div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">Canonical stages (${stages.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${stages.map(s => `<span class="pill">${esc(s.id)}</span>`).join('')}</div>
    </div>
  `;
  // ---- Zoom controls (scale the rendered size; the wrap scrolls/pan) ----
  const svgEl = document.getElementById('lc-svg');
  let scale = 1;
  const applyScale = () => {
    const w = Math.round(contentW * scale), h = Math.round(contentH * scale);
    svgEl.setAttribute('width', w); svgEl.setAttribute('height', h);
  };
  document.getElementById('lc-in')?.addEventListener('click', () => { scale = Math.min(3, scale * 1.25); applyScale(); });
  document.getElementById('lc-out')?.addEventListener('click', () => { scale = Math.max(0.5, scale / 1.25); applyScale(); });
  document.getElementById('lc-100')?.addEventListener('click', () => { scale = 1; applyScale(); });
  document.getElementById('lc-fit')?.addEventListener('click', () => {
    const wrap = document.getElementById('lc-wrap');
    scale = Math.max(0.5, Math.min(1, (wrap.clientWidth - 24) / contentW));
    applyScale(); wrap.scrollLeft = 0; wrap.scrollTop = 0;
  });
  applyScale();
  if (window.hydrateIcons) window.hydrateIcons();
}

export async function renderMeasures() {
  const [d, cov] = await Promise.all([
    api('GET', '/admin/measures'),
    api('GET', '/admin/measures/coverage').catch(() => null),
  ]);
  const covStrip = cov ? `
    <div class="cards" style="grid-template-columns: repeat(4,1fr);margin-bottom:12px;">
      <div class="stat-card"><div class="num">${cov.syncedTotal ?? 0}</div><div class="lbl">Synced &amp; evaluable (CQL)</div></div>
      <div class="stat-card"><div class="num">${cov.embeddedTotal ?? 0}</div><div class="lbl">Embedded (CQL-free)</div></div>
      <div class="stat-card"><div class="num">${cov.catalogTotal ?? 0}</div><div class="lbl">Catalog measures</div></div>
      <div class="stat-card"><div class="num">${cov.evaluableTotal ?? 0}</div><div class="lbl">Evaluable total</div></div>
    </div>` : '';
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">CMS measure catalog</h2><p class="page-sub">${d.count} measures across ESRD-QIP, Hospital IQR/VBP, MIPS, PI, NHSN, CMS-0057-F. Click <b>Evaluate</b> to run the real CQL evaluator on a synthetic hypertensive patient. Catalog ids are accepted too — the evaluator resolves <code>cms:</code>/plain CMS ids against the synced eCQM store.</p></div>
      <button class="btn btn-primary" id="ms-sync"><i data-lucide="refresh-cw"></i> Sync eCQM store</button></div>
    ${covStrip}
    <div id="ms-sync-status" class="muted" style="font-size:12px;margin-bottom:8px;"></div>
    <div id="ms-synced-store" style="margin-bottom:10px;"></div>
    <div class="detail" style="margin-bottom:10px;padding:10px 12px;">
      <div class="field-row" style="align-items:flex-end;">
        <div class="field"><label>Evaluation period — start</label><input id="ms-period-start" type="date" value="${currentYearPeriod().start}"></div>
        <div class="field"><label>End</label><input id="ms-period-end" type="date" value="${currentYearPeriod().end}"></div>
        <div class="field" style="flex:1;"><span class="muted" style="font-size:12px;">Measurement period sent to the CQL evaluator when you score a measure below.</span></div>
      </div>
    </div>
    <div id="measures-grid"></div>
    <div id="measure-eval-out"></div>
  `;
  // Show the synced store (fixture + any pulled eCQM measures).
  const loadStore = async () => {
    const el = document.getElementById('ms-synced-store');
    if (!el) return;
    try {
      const store = await (await fetch('/admin/measures/store')).json();
      const list = store.measures || [];
      el.innerHTML = `<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">Synced eCQM store (${list.length}) — CQL-evaluable:</div>` +
        (list.length ? list.map((m) => `<span class="pill muted" style="margin:2px;"><code>${esc(m.id)}</code>${m.cmsId ? ` · ${esc(m.cmsId)}` : ''}</span>`).join(' ') : '<span class="muted">empty — run Sync eCQM store or scripts/seed-measure-store.mjs</span>');
    } catch { /* store not loaded */ }
  };
  document.getElementById('ms-sync')?.addEventListener('click', async () => {
    const btn = document.getElementById('ms-sync');
    const status = document.getElementById('ms-sync-status');
    const o = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> Syncing…';
    status.textContent = 'Pulling measures from github.com/cqframework (needs network)…';
    try {
      const res = await fetch('/admin/measures/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || res.status);
      const summary = (j.results || []).map((r) => `${r.repo}: ${r.measuresSynced} measures / ${r.librariesSynced} libraries${r.skipped ? ' (unchanged)' : ''}`).join('; ');
      status.innerHTML = `<span style="color:var(--good);">✓ Synced — ${summary || 'no change'}</span>`;
      toast('eCQM store synced', 'good');
      loadStore();
    } catch (err) {
      status.innerHTML = `<span style="color:var(--bad);">Sync failed: ${esc(String(err))}</span> <span class="muted">(offline? The local M21Basic fixture keeps the store non-empty.)</span>`;
    } finally {
      btn.disabled = false; btn.innerHTML = o;
      if (window.hydrateIcons) window.hydrateIcons();
    }
  });
  loadStore();
  const covByMeasure = new Map((cov?.catalog || []).map((c) => [c.id, c]));
  dataGrid({
    el: 'measures-grid', filename: 'measures', pageSize: 25, empty: 'No measures found.',
    columns: [
      { key: 'id', label: 'ID', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'programId', label: 'Program', render: (v) => v ? `<span class="pill brand">${esc(v)}</span>` : '—' },
      { key: 'name', label: 'Description', render: (v, r) => esc(r.name || r.description || '') },
      { key: '_eval', label: 'Evaluable', sortable: false, filter: false, render: (_v, r) => { const src = covByMeasure.get(r.id)?.source; return src === 'synced' ? '<span class="pill good">CQL</span>' : src === 'embedded' ? '<span class="pill brand">embedded</span>' : '<span class="muted">—</span>'; } },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<button class="btn btn-ghost" onclick="measureEvaluate('${esc(r.id)}', this)"><i data-lucide="flask-conical"></i> Evaluate</button>` },
    ],
    data: d.measures,
  });
}
