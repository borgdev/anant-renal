import { S } from '../state.js';
import { api, drafts, ensurePacks } from '../core/api.js';
import { main } from '../core/shell.js';
import { dataGrid, esc, hydrateIcons, toast } from '../core/theme.js';

export async function draftsFromServer() {
  try {
    const res = await fetch('/admin/drafts', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('drafts-unavailable');
    const j = await res.json();
    return Array.isArray(j.drafts) ? j.drafts : null;
  } catch { return null; }
}

export async function renderAgentRuntime() {
  const [realmsData, agentsData, draftsData] = await Promise.all([
    api('GET', '/admin/realms').catch(() => ({ realms: [] })),
    api('GET', '/admin/agents').catch(() => ({ agents: [] })),
    fetch('/admin/drafts').then((r) => r.json()).catch(() => ({ drafts: [] })),
  ]);
  const realmsArr = (realmsData.realms || []).map((r) => r.id);
  const specOpts = [
    ...((draftsData.drafts || []).map((d) => ({ packId: d.packId, agentId: d.id, source: 'draft', label: `draft · ${d.packId}/${d.id}` }))),
    ...((agentsData.agents || []).map((a) => ({ packId: a.packId, agentId: a.id, source: 'published', label: `published · ${a.packId}/${a.id}` }))),
  ];
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Agent runtime</h2>
      <p class="page-sub">Ask a knowledge-aware agent — it reasons (ReAct or Plan-and-Execute), calls knowledge tools, and answers with citations. Backed by the real agent runner over your knowledge substrate. Scope to a realm to cite its local corpus, or run an authored agent spec.</p></div></div>
    <div class="section-card">
      <h3>Ask the agent</h3>
      <div class="field-row">
        <div class="field" style="flex:1;"><label>Question</label><input id="ar-q" placeholder="Cite the CMS165 numerator criteria and show me the value set expansion."></div>
        <div class="field"><label>Realm (local corpus)</label><select id="ar-realm"><option value="">— no realm —</option>${realmsArr.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}</select></div>
        <div class="field"><label>Strategy</label><select id="ar-strategy"><option value="auto">Auto</option><option value="react">ReAct</option><option value="plan-and-execute">Plan & execute</option></select></div>
        <div class="field"><label>Max steps</label><input id="ar-steps" type="number" value="6" min="1" max="20" style="width:80px"></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="ar-run"><i data-lucide="bot"></i> Run agent</button></div>
      </div>
      <div id="ar-out" class="muted" style="font-size:13px;margin-top:8px;">Ask a question to see the agent's reasoning and answer.</div>
    </div>
    <div class="section-card">
      <h3>Run by agent spec</h3>
      <p class="page-sub" style="font-size:12px;margin:0 0 8px;">Run an authored agent (draft or published) as a real, traceable turn — its persona, governance and plan render into the run's instructions.</p>
      <div class="field-row">
        <div class="field" style="flex:1;"><label>Agent spec</label><select id="ars-spec"><option value="">— pick an agent —</option>${specOpts.map((s) => `<option value="${esc(s.agentId)}" data-pack="${esc(s.packId)}" data-source="${esc(s.source)}">${esc(s.label)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;"><label>Question (optional — defaults to the spec description)</label><input id="ars-q" placeholder="e.g. Which patients are at risk and what protocol applies?"></div>
        <div class="field"><label>Realm</label><select id="ars-realm"><option value="">— no realm —</option>${realmsArr.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}</select></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="ars-run"><i data-lucide="bot"></i> Run spec</button></div>
      </div>
      <div id="ars-out" class="muted" style="font-size:13px;margin-top:8px;">Pick an agent spec and run it.</div>
    </div>
    <div class="section-card"><h3>Recent turns</h3><div id="ar-history"><div class="muted" style="font-size:13px;">Runs this session appear here.</div></div></div>
    <div class="section-card"><h3>Recorded runs <span class="muted" style="font-weight:400;font-size:11px;">(authoring → runtime feedback — measure scores + citations)</span></h3><div id="ar-recorded"><div class="muted" style="font-size:13px;">No recorded runs yet.</div></div></div>`;
  const history = [];
  const loadRuns = async () => {
    const el = document.getElementById('ar-recorded');
    if (!el) return;
    try {
      const j = await (await fetch('/admin/knowledge/agent/runs?limit=10')).json();
      const runs = j.runs || [];
      el.innerHTML = runs.length === 0
        ? '<div class="muted" style="font-size:13px;">No recorded runs yet.</div>'
        : runs.map((r) => `<div style="padding:6px 0;border-bottom:1px dashed var(--border);">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;">${r.agent ? `<span class="pill brand">${esc(r.agent.agentId)}</span><span class="pill muted">${esc(r.agent.source)}</span>` : '<span class="pill muted">ad-hoc</span>'}<span class="pill muted">${esc(r.strategy || 'react')}</span><span class="muted">${new Date(r.at).toLocaleTimeString()}</span></div>
            <div style="font-size:13px;">${esc(r.question)}</div>
            <div class="muted" style="font-size:12px;">${(r.citations || []).length} citation${r.citations.length === 1 ? '' : 's'}${(r.measureScores || []).length ? ` · measures: ${r.measureScores.map((m) => `<code>${esc(m.measureId)}</code> ${m.met ? '✓' : '✗'}`).join(', ')}` : ''}</div>
          </div>`).join('');
    } catch { /* offline */ }
  };
  loadRuns();
  const renderHistory = () => {
    const el = document.getElementById('ar-history');
    if (!el) return;
    el.innerHTML = history.length ? history.map((h) => `<div style="padding:6px 0;border-bottom:1px dashed var(--border);"><div style="font-size:13px;"><code>${esc(h.strategy)}</code>${h.spec ? ` <span class="pill brand">${esc(h.spec)}</span>` : ''} <span class="muted">· ${new Date(h.at).toLocaleTimeString()}</span></div><div style="font-size:13px;">${esc(h.q)}</div><div class="muted" style="font-size:12px;">${esc((h.answer || '').slice(0, 160))}</div></div>`).join('') : '<div class="muted" style="font-size:13px;">Runs this session appear here.</div>';
  };
  const renderOutcome = (j, specLabel) => {
    const steps = (j.steps || []).map((s) => {
      const icon = s.kind === 'thought' ? 'brain' : s.kind === 'tool' ? 'wrench' : s.kind === 'plan' ? 'list-checks' : 'message-square';
      const extra = s.tool ? ` <code>${esc(s.tool.name)}</code>` : '';
      return `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border);"><i data-lucide="${icon}" style="width:14px;height:14px;margin-top:2px;color:var(--muted);flex-shrink:0;"></i><div style="font-size:13px;"><span class="pill muted" style="font-size:10px;">${esc(s.kind)}</span>${extra}<div class="muted" style="font-size:12px;">${esc(s.text || '')}</div></div></div>`;
    }).join('');
    return `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">${specLabel ? `<span class="pill brand">${esc(specLabel)}</span>` : ''}<span class="pill brand">${esc(j.strategy || 'react')}</span><span class="pill muted">${esc(j.episodeId || '')}</span>${j.recorded ? '<span class="pill good">✓ recorded</span>' : ''}<span class="pill good">${(j.citations || []).length} citation${j.citations.length === 1 ? '' : 's'}</span></div>
      <div class="section-card" style="margin:0 0 10px;"><strong>Answer</strong><div style="font-size:14px;margin-top:4px;white-space:pre-wrap;">${esc(j.answer || '')}</div>
        ${(j.citations || []).length ? `<div class="muted" style="font-size:12px;margin-top:6px;">${j.citations.map((c) => `<code>${esc(c.sourceId)}</code>${c.artifactId ? ` · ${esc(c.artifactId)}` : ''}`).join('<br>')}</div>` : ''}
      </div>
      <strong style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Reasoning trace</strong>
      ${steps || '<div class="muted" style="font-size:13px;">no steps</div>'}`;
  };
  const run = async () => {
    const q = document.getElementById('ar-q').value.trim();
    if (!q) { toast('Enter a question', 'err'); return; }
    const out = document.getElementById('ar-out');
    out.innerHTML = '<div class="muted">Agent is thinking…</div>';
    try {
      const strategy = document.getElementById('ar-strategy').value;
      const realmId = document.getElementById('ar-realm').value;
      const res = await fetch('/admin/knowledge/agent/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, ...(strategy !== 'auto' ? { strategy } : {}), maxSteps: Number(document.getElementById('ar-steps').value || 6), ...(realmId ? { realmId } : {}) }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      out.innerHTML = renderOutcome(j);
      history.unshift({ q, at: new Date().toISOString(), strategy: j.strategy, answer: j.answer });
      renderHistory();
      if (window.hydrateIcons) window.hydrateIcons();
      if (typeof loadRuns === 'function') loadRuns();
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  };
  const runSpec = async () => {
    const sel = document.getElementById('ars-spec');
    const opt = sel.selectedOptions[0];
    if (!opt || !opt.value) { toast('Pick an agent spec', 'err'); return; }
    const out = document.getElementById('ars-out');
    out.innerHTML = '<div class="muted">Running agent spec…</div>';
    try {
      const body = {
        packId: opt.getAttribute('data-pack'), agentId: opt.value, source: opt.getAttribute('data-source'),
        ...(document.getElementById('ars-q').value.trim() ? { question: document.getElementById('ars-q').value.trim() } : {}),
        ...(document.getElementById('ars-realm').value ? { realmId: document.getElementById('ars-realm').value } : {}),
      };
      const res = await fetch('/admin/knowledge/agent/run-spec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || (j.message || res.status));
      out.innerHTML = renderOutcome(j, `${j.spec?.displayName || j.spec?.id} · ${j.spec?.source || 'published'}`);
      history.unshift({ q: j.spec?.id || 'spec-run', at: new Date().toISOString(), strategy: j.strategy, answer: j.answer, spec: j.spec?.displayName });
      renderHistory();
      if (window.hydrateIcons) window.hydrateIcons();
      if (typeof loadRuns === 'function') loadRuns();
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  };
  document.getElementById('ar-run')?.addEventListener('click', run);
  document.getElementById('ar-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  document.getElementById('ars-run')?.addEventListener('click', runSpec);
  document.getElementById('ars-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSpec(); });
}

export async function renderAgents() {
  await ensurePacks();
  main.innerHTML = `
    <div class="page-header">
      <div><h2 class="page-title">Published agents</h2><p class="page-sub">Live in the runtime — invocable via triggers, replayable, metered.</p></div>
      <button class="btn btn-primary" onclick="goTo('new')">+ Create agent</button>
    </div>
    <div class="filters">
      <select id="pack-filter"><option value="">All packs</option>${S.PACKS.map(p => `<option>${p}</option>`).join('')}</select>
    </div>
    <div id="agents-body">Loading…</div>
  `;
  let grid = null;
  const load = async () => {
    const pack = document.getElementById('pack-filter').value;
    const params = new URLSearchParams();
    if (pack) params.set('pack', pack);
    const data = await api('GET', '/admin/agents?' + params.toString());
    const runs = await (async () => { try { const r = await (await fetch('/admin/knowledge/agent/runs?limit=200')).json(); return r.runs || []; } catch { return []; } })();
    const runMap = {};
    runs.forEach((r) => { if (r.agent?.agentId) { const k = r.agent.agentId; runMap[k] = runMap[k] || { count: 0, measures: new Map() }; runMap[k].count++; (r.measureScores || []).forEach((m) => { const cur = runMap[k].measures.get(m.measureId) || { total: 0, met: 0 }; cur.total++; if (m.met) cur.met++; runMap[k].measures.set(m.measureId, cur); }); } });
    const agents = (data.agents || []).map((a) => ({ ...a, __runtime: runMap[a.id] }));
    const body = document.getElementById('agents-body');
    if (!grid) {
      body.innerHTML = '<div id="agents-grid"></div>';
      grid = dataGrid({
        el: 'agents-grid', filename: 'agents', pageSize: 25, empty: 'No agents found.',
        columns: [
          { key: 'id', label: 'ID', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'displayName', label: 'Name', render: (v, r) => `${esc(v)} ${r.__justPublished ? '<span class="pill good">just published</span>' : ''}` },
          { key: 'packId', label: 'Pack', render: (v) => `<span class="pill brand">${esc(v)}</span>` },
          { key: 'setting', label: 'Setting', render: (v) => esc(v || '—') },
          { key: 'triggerKind', label: 'Trigger', render: (v, r) => `<span class="pill muted">${esc(v)}${r.triggerEventType ? ': ' + esc(r.triggerEventType) : ''}</span>` },
          { key: 'baseFeeUsd', label: 'Base fee', align: 'right', render: (v) => v != null ? '$' + v : '<span class="muted">—</span>' },
          { key: '__runtime', label: 'Runtime', render: (_v, r) => r.__runtime ? `<span class="pill good">${r.__runtime.count} run${r.__runtime.count === 1 ? '' : 's'}</span> ${[...r.__runtime.measures.entries()].map(([m, s]) => `<code title="${s.met}/${s.total} met">${esc(m)}</code>`).join(' ')}` : '<span class="muted">—</span>' },
          { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<button class="btn btn-ghost" onclick="cloneAgent('${esc(r.packId)}','${esc(r.id)}')">Clone</button>` },
        ],
        data: agents,
      });
    } else {
      grid.refresh(agents);
    }
  };
  document.getElementById('pack-filter')?.addEventListener('change', load);
  load();
}

export async function renderDrafts() {
  const live = await draftsFromServer();
  const list = live !== null ? live : drafts;
  const runs = await (async () => { try { const r = await (await fetch('/admin/knowledge/agent/runs?limit=200')).json(); return r.runs || []; } catch { return []; } })();
  const runMap = {};
  runs.forEach((r) => { if (r.agent?.agentId) { const k = r.agent.agentId; runMap[k] = runMap[k] || { count: 0, measures: new Map() }; runMap[k].count++; (r.measureScores || []).forEach((m) => { const cur = runMap[k].measures.get(m.measureId) || { total: 0, met: 0 }; cur.total++; if (m.met) cur.met++; runMap[k].measures.set(m.measureId, cur); }); } });
  const rows = list.map(d => {
    const rt = runMap[d.id];
    return `
    <tr>
      <td><code>${esc(d.id)}</code></td>
      <td><span class="pill brand">${esc(d.packId)}</span></td>
      <td>${d.status === 'in-review' ? '<span class="pill warn">in review</span>' : '<span class="pill muted">draft</span>'}</td>
      <td>${d.validation?.ok ? '<span class="pill good">valid</span>' : '<span class="pill bad">' + (d.validation?.errors?.length ?? 0) + ' error(s)</span>'}</td>
      <td class="muted">${new Date(d.updatedAt).toLocaleString()}</td>
      <td>${rt ? `<span class="pill good">${rt.count} run${rt.count === 1 ? '' : 's'}</span> ${[...rt.measures.entries()].map(([m, s]) => `<code title="${s.met}/${s.total} met">${esc(m)}</code>`).join(' ')}` : '<span class="muted">—</span>'}</td>
      <td class="row-actions">
        <button class="btn btn-ghost" onclick="editDraft('${esc(d.packId)}','${esc(d.id)}')">Edit</button>
        ${d.status === 'in-review' && d.validation?.ok ? `<button class="btn btn-primary" onclick="publishDraft('${esc(d.packId)}','${esc(d.id)}')">Publish</button>` : ''}
        <button class="btn" onclick="deleteDraft('${esc(d.packId)}','${esc(d.id)}')">Delete</button>
      </td>
    </tr>
  `; }).join('');
  main.innerHTML = `
    <div class="page-header">
      <div><h2 class="page-title">Drafts</h2><p class="page-sub">Author agents, validate, submit for review, then publish. All actions audited on disk by the authoring service.</p></div>
      <button class="btn btn-primary" onclick="goTo('new')">+ New draft</button>
    </div>
    ${list.length === 0 ? `<div class="detail muted" style="text-align:center;padding:40px;">No drafts yet. Click <b>+ New draft</b> to create your first agent.</div>` :
    `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Pack</th><th>Status</th><th>Validation</th><th>Updated</th><th>Runtime</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`}
  `;
}
