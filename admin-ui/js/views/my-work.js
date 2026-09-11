import { S } from '../state.js';
import { setCount } from '../core/scope.js';
import { main } from '../core/shell.js';
import { esc, hydrateIcons } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export const WQ_ACTION_LABEL = {
  approve: 'Approve', reject: 'Reject', escalate: 'Escalate', validate: 'Validate', activate: 'Activate',
  rollback: 'Rollback', acknowledge: 'Acknowledge', 'request-approval': 'Request approval', canary: 'Canary',
  promote: 'Promote', fail: 'Fail',
  // NOT 'Review': this action RECORDS a decision (the entry reads suggested →
  // reviewed) and does not open anything, while the row title does. Labelled
  // 'Review', an operator clicking it to read the criteria silently attested to
  // the suggestion instead. The label now names the record it writes.
  review: 'Mark reviewed', decline: 'Decline',
};

export const WQ_KIND_ICON = { episode: 'circle-dot', review: 'shield-check', release: 'git-branch', dlq: 'alert-octagon', cohort: 'users' };

export const WQ_KIND_LABEL = { episode: 'Outcome episode', review: 'Evidence review', release: 'Release', dlq: 'DLQ incident', cohort: 'Cohort suggestion' };

export const WQ_TONE = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--good)' };

export async function renderMyWork() {
  await wqLoad();
  wqRender();
  wqStartPolling();
}

export async function renderPlatformDlq() {
  const d = await plFetch('GET', '/admin/platform/dlq');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Dead-letter queue</h2>
      <p class="page-sub">Poison messages, bridge incidents and outbox failures — with evidence, owner, idempotent replay and audit. Replay publishes with the ORIGINAL business key so a consumer cannot create a duplicate effect.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${d.brokerDepth}</div><div class="lbl">Broker DLQ depth</div></div>
      <div class="stat-card"><div class="num">${d.outbox.pending}</div><div class="lbl">Outbox pending</div></div>
      <div class="stat-card"><div class="num">${d.outbox.dead}</div><div class="lbl">Outbox dead</div></div>
      <div class="stat-card"><div class="num">${d.incidents.length}</div><div class="lbl">Bridge incidents</div></div>
    </div>
    <div class="detail">
      <h3 style="margin-top:0;">Incidents</h3>
      <table style="width:100%;">
        <thead><tr><th>Item</th><th>Topic</th><th>Incident</th><th>At</th><th>Actions</th></tr></thead>
        <tbody>${(d.items || []).map((i) => `
          <tr><td><code>${esc(i.id)}</code></td><td>${esc(i.topic ?? '—')}</td><td>${esc(i.incident ?? '—')}</td><td>${esc(i.publishedAt ?? '—')}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-ghost" onclick="plDlqDetail('${esc(i.id)}')">Detail</button>
            <button class="btn btn-ghost" onclick="plDlqAction('${esc(i.id)}','acknowledge')">Acknowledge</button>
            <button class="btn btn-ghost" onclick="plDlqAction('${esc(i.id)}','replay')">Replay</button>
          </td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">No incidents — the event plane is healthy.</td></tr>'}</tbody>
      </table>
      <div id="dlq-detail" style="margin-top:10px;"></div>
      <p style="font-size:12px;color:var(--muted);margin-top:10px;">Durable repair/replay is also available via the Kafka bridge.</p>
    </div>
  `;
}

export async function wqAct(id, action, reason) {
  wqState.busy = `${id}:${action}`;
  wqState.notice = '';
  wqRender();
  try {
    const res = await plFetch('POST', '/api/work/' + encodeURIComponent(id) + '/actions', {
      action,
      approver: (S.sessionUser && S.sessionUser.username) || 'operator',
      idempotencyKey: `${id}:${action}:${Date.now()}`,
      ...(reason ? { reason } : {}),
    });
    wqState.notice = `${action} recorded → ${res.state ?? action}${res.duplicate ? ' (duplicate idempotent replay)' : ''}`;
    if (wqState.selected === id) { wqState.selected = null; wqState.detail = null; }
  } catch (e) {
    wqState.notice = `Action failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    wqState.busy = '';
  }
  await wqLoad();
  wqRender();
}

export function wqBegin(id, action) {
  if (action === 'decline') { wqState.declining = { id, reason: '' }; wqRender(); return; }
  void wqAct(id, action);
}

export function wqCancelDecline() { wqState.declining = null; wqRender(); }

export function wqClose() { wqState.selected = null; wqState.detail = null; wqState.detailError = ''; wqRender(); }

export function wqConfirmDecline(id) {
  const reason = (wqState.declining?.reason ?? '').trim();
  if (reason.length < 4) return;
  wqState.declining = null;
  void wqAct(id, 'decline', reason);
}

export function wqCriteriaRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '<span class="muted" style="font-size:11px;">none</span>';
  const tone = (o) => (o === 'met' ? 'var(--good)' : o === 'not-met' ? 'var(--bad)' : 'var(--warn)');
  return `<table style="width:100%;font-size:12px;margin-top:4px;">
    <thead><tr><th>Criterion</th><th>Measured</th><th>Outcome</th></tr></thead>
    <tbody>${rows.map((c) => `<tr>
      <td><code>${esc(c.expected ?? '')}</code>${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}</td>
      <td>${c.observed === null || c.observed === undefined ? '<span class="muted">not resolvable</span>' : esc(String(c.observed))}</td>
      <td style="color:${tone(c.outcome)};font-weight:600;">${esc(String(c.outcome ?? ''))}</td>
    </tr>`).join('')}</tbody></table>`;
}

export function wqDeclineReason(value) {
  if (!wqState.declining) return;
  wqState.declining.reason = value;
  // Re-render only so the confirm button enables at the same threshold the server
  // enforces; the input is re-rendered from state, so nothing typed is lost.
  wqRender();
  const input = document.querySelector('input.input');
  if (input) { input.focus(); input.setSelectionRange(value.length, value.length); }
}

export function wqDetailHTML() {
  const d = wqState.detail;
  if (wqState.detailError) {
    return `<div class="detail" style="margin-top:12px;"><div style="color:var(--bad);font-size:12px;">${esc(wqState.detailError)}</div></div>`;
  }
  if (!d) return '';
  const kv = (obj) => Object.entries(obj ?? {})
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `<div><span class="muted" style="font-size:11px;">${esc(k)}</span><div style="font-weight:600;">${esc(String(v))}</div></div>`).join('');
  const overview = { ...(d.overview ?? {}) };
  const entryCriteria = overview.entryCriteria;
  const exitCriteria = overview.exitCriteria;
  delete overview.entryCriteria;
  delete overview.exitCriteria;
  const activity = Array.isArray(d.activity) ? d.activity : [];
  const policy = d.policy ?? {};
  const decision = d.decision ?? {};
  return `<div class="detail" style="margin-top:12px;border-color:var(--brand);">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
      <h3 style="margin:0;">${esc(d.title ?? 'Work item')}</h3>
      <button class="btn btn-ghost" onclick="wqClose()">Close</button>
    </div>
    <div class="muted" style="font-size:11px;margin-top:4px;">${esc(String(d.kind ?? ''))} · ${esc(String(d.scope ?? ''))} · owner ${esc(String(d.owner ?? ''))}</div>
    ${d.why ? `<div style="margin-top:8px;font-size:13px;">${esc(String(d.why))}</div>` : ''}
    ${Object.keys(overview).length ? `<h4 style="margin:10px 0 0;font-size:12px;">Overview</h4><div class="kv" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:6px;">${kv(overview)}</div>` : ''}
    ${entryCriteria ? `<h4 style="margin:10px 0 0;font-size:12px;">Entry criteria</h4>${wqCriteriaRows(entryCriteria)}` : ''}
    ${exitCriteria ? `<h4 style="margin:10px 0 0;font-size:12px;">Exit criteria</h4>${wqCriteriaRows(exitCriteria)}` : ''}
    <h4 style="margin:10px 0 0;font-size:12px;">Decision</h4>
    <div style="font-size:12px;">Allowed: ${(decision.allowed ?? []).map((a) => `<span class="pill muted">${esc(WQ_ACTION_LABEL[a] ?? a)}</span>`).join(' ')}
      ${(decision.reasonRequiredFor ?? []).length ? `<span class="muted"> · a reason is required for ${esc((decision.reasonRequiredFor ?? []).join(', '))}</span>` : ''}</div>
    ${Object.keys(policy).length ? `<h4 style="margin:10px 0 0;font-size:12px;">Policy</h4><div style="font-size:12px;">
      ${policy.approvalClass ? `class <b>${esc(String(policy.approvalClass))}</b>` : ''}
      ${policy.actsOnPatient === false ? ' · <b>this item never acts on a patient</b>' : ''}
      ${Array.isArray(policy.mayNever) && policy.mayNever.length ? `<div class="muted" style="margin-top:4px;">may never: ${esc(policy.mayNever.join('; '))}</div>` : ''}
      ${Array.isArray(policy.guard) && policy.guard.length ? `<div class="muted">guards: ${esc(policy.guard.join('; '))}</div>` : ''}
    </div>` : ''}
    <div style="font-size:12px;margin-top:8px;">${d.execution === null || d.execution === undefined
      ? '<span class="pill mint">nothing is executed by this item</span>'
      : `<span class="pill amber">execution: ${esc(String(d.execution))}</span>`}</div>
    ${activity.length ? `<h4 style="margin:10px 0 0;font-size:12px;">Activity</h4><div style="font-size:12px;margin-top:4px;">${activity.map((a) => `<div style="padding:3px 0;border-bottom:1px solid var(--line);"><span class="muted">${esc(String(a.at ?? ''))}</span> ${esc(String(a.from ?? ''))} → <b>${esc(String(a.to ?? ''))}</b> <span class="muted">${esc(String(a.by ?? ''))}</span>${a.note ? `<div class="muted">${esc(String(a.note))}</div>` : ''}</div>`).join('')}</div>` : ''}
  </div>`;
}

export function wqFilter(f) { wqState.filter = f; wqRender(); }

export async function wqLoad() {
  try {
    const j = await plFetch('GET', '/api/work');
    const all = Array.isArray(j.items) ? j.items : [];
    // The queue spans every console the role can open; this console renders its own.
    wqState.items = all.filter((i) => i.console === 'ops');
    wqState.elsewhere = all.filter((i) => i.console !== 'ops').length;
    wqState.error = '';
  } catch (e) {
    wqState.error = e instanceof Error ? e.message : String(e);
  }
  wqState.loaded = true;
}

export async function wqOpen(id) {
  wqState.selected = id;
  wqState.detail = null;
  wqState.detailError = '';
  wqRender();
  try {
    const j = await plFetch('GET', '/api/work/' + encodeURIComponent(id));
    wqState.detail = j.detail ?? null;
    if (!wqState.detail) wqState.detailError = 'The server returned no detail for this item.';
  } catch (e) {
    wqState.detailError = e instanceof Error ? e.message : String(e);
  }
  wqRender();
  document.getElementById('wq-detail-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export async function wqRefresh() {
  await wqLoad();
  wqRender();
}

export function wqRender() {
  const items = wqState.items;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const i of items) if (counts[i.urgency] !== undefined) counts[i.urgency] += 1;
  const visible = wqState.filter === 'all' ? items : items.filter((i) => i.urgency === wqState.filter);
  setCount('c-mywork', items.length);

  const tabs = [['all', 'All', items.length], ['high', 'High', counts.high], ['medium', 'Medium', counts.medium], ['low', 'Low', counts.low]]
    .map(([id, label, n]) => `<button class="btn ${wqState.filter === id ? 'btn-primary' : 'btn-ghost'}" onclick="wqFilter('${id}')">${label} <span class="muted">${n}</span></button>`).join(' ');

  const rows = visible.map((item) => {
    const declining = wqState.declining && wqState.declining.id === item.id;
    return `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:${wqState.selected === item.id ? 'color-mix(in srgb, var(--mint) 7%, transparent)' : 'color-mix(in srgb, var(--elevate) 2%, transparent)'};">
      <div style="display:flex;gap:10px;align-items:flex-start;">
        <span style="flex:0 0 auto;width:26px;height:26px;border-radius:6px;display:grid;place-items:center;background:color-mix(in srgb, ${WQ_TONE[item.urgency] ?? 'var(--muted)'} 15%, transparent);color:${WQ_TONE[item.urgency] ?? 'var(--muted)'};"><i data-lucide="${WQ_KIND_ICON[item.kind] ?? 'circle-dot'}"></i></span>
        <div style="flex:1;min-width:0;">
          <button class="btn btn-ghost" style="padding:0;text-align:left;font-weight:600;" onclick="wqOpen('${esc(item.id)}')">${esc(item.title)}</button>
          <div class="muted" style="font-size:11px;margin-top:2px;">${esc(item.summary ?? '')}</div>
          <div class="muted" style="font-size:11px;margin-top:4px;">${esc(WQ_KIND_LABEL[item.kind] ?? item.kind)} · ${esc(item.scope ?? '')} · ${esc(item.owner ?? '')} · due ${esc(item.sla ?? '')}</div>
          ${declining ? `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
              <input class="input" style="flex:1 1 260px;" placeholder="Why is this suggestion wrong? (read back when the criterion is tuned)" value="${esc(wqState.declining.reason)}" oninput="wqDeclineReason(this.value)" />
              <button class="btn btn-primary" ${wqState.declining.reason.trim().length < 4 ? 'disabled' : ''} onclick="wqConfirmDecline('${esc(item.id)}')">Confirm decline</button>
              <button class="btn btn-ghost" onclick="wqCancelDecline()">Cancel</button>
            </div>` : ''}
        </div>
        <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">
            <span class="pill muted">${esc(item.state ?? '')}</span>
            <span class="pill" style="color:${WQ_TONE[item.urgency] ?? 'inherit'};">${esc(item.urgency)}</span>
          </div>
          ${declining ? '' : `<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${(item.actions ?? []).map((a) => `<button class="btn ${a === 'approve' || a === 'activate' ? 'btn-primary' : 'btn-ghost'}" ${wqState.busy === `${item.id}:${a}` ? 'disabled' : ''} onclick="wqBegin('${esc(item.id)}','${esc(a)}')">${esc(WQ_ACTION_LABEL[a] ?? a)}</button>`).join('')}</div>`}
        </div>
      </div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">My Work</h2>
      <p class="page-sub">The server-assembled decision queue for this console, scoped to your role and capability. Nothing in it executes anything: a suggestion is a statement about state, and acting on a patient stays a separate proposal → approval → outcome episode.</p></div>
      <div style="display:flex;gap:6px;align-items:flex-start;"><button class="btn" onclick="wqRefresh()">Refresh</button></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${items.length}</div><div class="lbl">Open in this console</div></div>
      <div class="stat-card"><div class="num" style="color:${counts.high ? 'var(--bad)' : 'inherit'};">${counts.high}</div><div class="lbl">High urgency</div></div>
      <div class="stat-card"><div class="num">${items.filter((i) => i.kind === 'cohort').length}</div><div class="lbl">Cohort suggestions</div></div>
      <div class="stat-card"><div class="num">${wqState.elsewhere}</div><div class="lbl">In the executive console</div></div>
    </div>
    <div style="display:flex;gap:6px;margin:10px 0;flex-wrap:wrap;">${tabs}</div>
    ${wqState.notice ? `<div style="margin-bottom:8px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:12px;">${esc(wqState.notice)}</div>` : ''}
    ${wqState.elsewhere > 0 ? `<div style="margin-bottom:8px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:12px;" class="muted">${wqState.elsewhere} item(s) in the queue belong to the <b>executive console</b> and are worked there. <a href="/exec/">Open executive console</a></div>` : ''}
    <div id="wq-detail-anchor"></div>
    ${!wqState.loaded ? '<div class="detail">Resolving your work queue…</div>'
      : wqState.error ? `<div class="detail" style="color:var(--bad);font-size:12px;">${esc(wqState.error)} — the server assembles My Work; reconnect to refresh.</div>`
      : items.length === 0 ? '<div class="detail">Nothing currently requires you at this role and scope. New signals appear here the moment the harness retains them.</div>'
      : visible.length === 0 ? `<div class="detail">No ${esc(wqState.filter)}-priority work.</div>`
      : `<div style="display:grid;gap:8px;">${rows}</div>`}
    ${wqDetailHTML()}`;
  hydrateIcons();
}

export function wqStartPolling() {
  wqStopPolling();
  wqTimer = setInterval(() => {
    if (S.currentView !== 'my-work') { wqStopPolling(); return; }
    // A re-render mid-sentence would discard a half-typed decline reason.
    if (wqState.declining) return;
    void wqLoad().then(() => wqRender());
  }, 10000);
}

export const wqState = {
  items: [], elsewhere: 0, filter: 'all', loaded: false, error: '', notice: '',
  busy: '', declining: null, selected: null, detail: null, detailError: '',
};

export function wqStopPolling() { if (wqTimer) { clearInterval(wqTimer); wqTimer = null; } }

export let wqTimer = null;
