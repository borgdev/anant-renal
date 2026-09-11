import { S } from '../state.js';
import { main } from '../core/shell.js';
import { esc, toast } from '../core/theme.js';

export async function renderSimulator() {
  let sim = null; let scenarios = [];
  try { const s = await simFetch('/admin/simulator/status'); sim = s.simulator || null; } catch (_) { /* offline */ }
  try { const sc = await simFetch('/admin/simulator/scenarios'); scenarios = sc.scenarios || []; } catch (_) { /* offline */ }
  const t = (sim && sim.totals) || { realms: 0, patients: 0, presences: 0, effects: 0 };
  const selectedId = (sim && sim.scenario) || simScenarioSel;
  const scenarioOptions = scenarios.map((s) => `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.label)}</option>`).join('') || `<option value="dialysis-demo">dialysis-demo</option>`;
  const realmRows = simRealmRowsHTML(sim && sim.realms);
  const running = sim && sim.status === 'running';
  const paused = sim && sim.status === 'paused';
  const status = (sim && sim.status) || 'idle';
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Simulator</h2>
      <p class="page-sub">Drives the whole stack on synthetic data: builds a fleet of sim realms and emits scripted events (labs, vitals, assessments, claims, safety flags) through real presences. The swarm reasoners, exec console, event feed and broker all run live off it. Status <span id="sim-status-pill" class="pill ${({ running: 'good', paused: 'warn', idle: 'muted' })[status] || 'muted'}">${esc(status)}</span> <span class="muted" style="font-size:11px;">· auto-refreshes while running</span>.</p></div></div>
    <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">
      <div class="stat-card"><div class="num" id="sim-stat-scenario">${sim && sim.scenario ? esc(sim.scenario) : '—'}</div><div class="lbl">Scenario</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-pace">${sim && sim.pace ? sim.pace.realmHoursPerTick + 'h' : '—'}</div><div class="lbl">Realm / tick</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-ticks">${sim ? sim.tickCount : 0}</div><div class="lbl">Ticks</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-events">${sim ? sim.eventCount : 0}</div><div class="lbl">Events</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-realms">${t.realms}</div><div class="lbl">Realms</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-patients">${t.patients}</div><div class="lbl">Patients</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-presences">${t.presences}</div><div class="lbl">Presences</div></div>
      <div class="stat-card"><div class="num" id="sim-stat-effects">${t.effects}</div><div class="lbl">Effects</div></div>
    </div>
    <div class="section-card"><h3>Control</h3>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <select id="sim-scenario" class="input" style="width:auto;min-width:260px;" onchange="simScenarioSel=this.value">${scenarioOptions}</select>
        <button id="sim-btn-start" class="btn btn-primary" onclick="simAction('/admin/simulator/start', { scenario: document.getElementById('sim-scenario').value }, this)" ${running ? 'disabled' : ''}>Start</button>
        <button id="sim-btn-pause" class="btn btn-ghost" onclick="simAction('/admin/simulator/pause', {}, this)" ${!running ? 'disabled' : ''}>Pause</button>
        <button id="sim-btn-resume" class="btn btn-ghost" onclick="simAction('/admin/simulator/resume', {}, this)" ${!paused ? 'disabled' : ''}>Resume</button>
        <button class="btn btn-ghost" onclick="simAction('/admin/simulator/step', { ticks: 1 }, this)">Step +1h</button>
        <button id="sim-btn-reset" class="btn btn-danger" onclick="simAction('/admin/simulator/reset', {}, this)" ${!sim || sim.status === 'idle' ? 'disabled' : ''}>Reset</button>
        <button class="btn btn-danger" onclick="simCleanup()" title="Stop the sim, drop sim realms, remove demo episodes/NBA decisions, prune delivered outbox events (frees disk)">Clean up demo</button>
      </div>
      <p class="detail muted" style="margin-top:10px;font-size:12px;">Start is idempotent (any prior fleet is reset first). Pause freezes realm clocks; Step advances every realm by one realm-hour deterministically; Reset tears the fleet down; <b>Clean up demo</b> additionally removes the demo decision fabric and prunes the delivered event-outbox backlog to free disk. Auto-start on boot: set <code>HH_DEMO_SIM=1</code>.</p>
    </div>
    <div class="section-card"><h3>Realms <span class="muted" style="font-weight:400;font-size:11px;">· live sim realms in the registry</span></h3><div id="sim-realm-rows">${realmRows}</div></div>
    <div class="detail muted" style="font-size:12px;">Surface: GET /admin/simulator/status · POST /admin/simulator/{start,pause,resume,step,reset}. Simulated effects flow through the normal write path: ledger → hypergraph → rules → perception → realm→broker bridge → canonical events → outbox/webhooks/SSE → exec console.</div>
  `;
  startSimRefresh();
}

export async function simAction(path, body, btn) {
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try {
    await simFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
  } catch (e) {
    alert(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
    await renderSimulator();
  }
}

export async function simCleanup() {
  if (!confirm('Clean up the demo?\n\n• Stops the simulator and drops its sim:* realms\n• Removes demo outcome episodes + NBA decisions\n• Prunes the delivered event-outbox backlog (frees disk)\n\nRead-only catalogs, substrate and admin config are kept.')) return;
  try {
    const r = await simFetch('/admin/demo/cleanup', { method: 'POST', body: JSON.stringify({}) });
    const rep = r.report || {};
    toast(`Demo cleaned · ${rep.outboxDeliveredRemoved ?? 0} outbox events pruned · ${rep.simRealmsRemoved ?? 0} sim realm(s) removed · ${rep.episodesRemoved ?? 0} episode(s)`, 'good');
  } catch (e) {
    toast('Cleanup failed: ' + e.message, 'err');
  }
  await renderSimulator();
}

export async function simFetch(path, init) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `request failed: ${path}`);
  return j;
}

export function simRealmRowsHTML(realms) {
  return ((realms) || []).map((r) => `
    <div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--border);flex-wrap:wrap;">
      <code style="min-width:150px;">${esc(r.id)}</code>
      <span class="pill muted" style="font-size:11px;">${esc(r.trajectoryEngine || 'legacy')}</span>
      <span class="muted" style="font-size:11px;white-space:nowrap;">seq ${r.seq} · ${esc(r.realmAt || '')}</span>
      <span class="muted" style="font-size:11px;white-space:nowrap;">patients ${r.patients} · presences ${r.presences} · effects ${r.effects}</span>
      ${r.pendingApprovals ? `<span class="pill warn" style="font-size:11px;">${r.pendingApprovals} pending HITL</span>` : ''}
    </div>`).join('') || '<div class="muted">No realms — press Start.</div>';
}

export let simRefreshTimer = null;

export let simScenarioSel = 'dialysis-demo';

export function startSimRefresh() {
  stopSimRefresh();
  simRefreshTimer = setInterval(async () => {
    if (S.currentView !== 'simulator') { stopSimRefresh(); return; }
    let sim = null;
    try { const s = await simFetch('/admin/simulator/status'); sim = s.simulator || null; } catch (_) { return; }
    updateSimStatus(sim);
  }, 2000);
}

export function stopSimRefresh() { if (simRefreshTimer) { clearInterval(simRefreshTimer); simRefreshTimer = null; } }

export function updateSimStatus(sim) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sim-stat-scenario', (sim && sim.scenario) || '—');
  set('sim-stat-pace', sim && sim.pace ? sim.pace.realmHoursPerTick + 'h' : '—');
  set('sim-stat-ticks', sim ? sim.tickCount : 0);
  set('sim-stat-events', sim ? sim.eventCount : 0);
  const t = (sim && sim.totals) || {};
  set('sim-stat-realms', t.realms || 0);
  set('sim-stat-patients', t.patients || 0);
  set('sim-stat-presences', t.presences || 0);
  set('sim-stat-effects', t.effects || 0);
  const pill = document.getElementById('sim-status-pill');
  if (pill) {
    const tone = { running: 'good', paused: 'warn', idle: 'muted' };
    const status = (sim && sim.status) || 'idle';
    pill.className = 'pill ' + (tone[status] || 'muted');
    pill.textContent = esc(status);
  }
  const rows = document.getElementById('sim-realm-rows');
  if (rows) rows.innerHTML = simRealmRowsHTML(sim && sim.realms);
  const running = sim && sim.status === 'running';
  const paused = sim && sim.status === 'paused';
  const b = (id, disabled) => { const el = document.getElementById(id); if (el) el.disabled = !!disabled; };
  b('sim-btn-start', running);
  b('sim-btn-pause', !running);
  b('sim-btn-resume', !paused);
  b('sim-btn-reset', !sim || sim.status === 'idle');
}
