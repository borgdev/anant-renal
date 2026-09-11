import { api } from '../core/api.js';
import { datetimeLocalToISO, toDatetimeLocal } from '../core/format.js';
import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export let brokerSince = '';

export async function renderBrokerPanel() {
  const b = await api('GET', '/admin/broker').catch(() => null);
  const drivers = await api('GET', '/admin/broker/drivers').catch(() => ({ drivers: [], current: 'none' }));
  const h = b?.health ?? { ok: false, driver: 'none' };
  const ob = b?.outbox ?? { pending: 0, delivered: 0, dead: 0 };
  const br = b?.bridge ?? { attached: 0, projected: 0, queued: 0, published: 0, failed: 0 };
  const driverPills = (drivers.drivers || []).map((d) => `<span class="pill ${d === drivers.current ? 'brand' : 'muted'}">${esc(d)}${d === drivers.current ? ' · active' : ''}</span>`).join(' ');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Event broker fabric</h2>
      <p class="page-sub">Publish + consume CanonicalEvents across every major broker behind one seam. The driver is selected by <code>HH_EVENTBROKER_DRIVER</code>; realm effects stream to it through the transactional outbox.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${esc(h.driver)}</div><div class="lbl">Driver ${h.ok ? '· online' : '· offline'}</div></div>
      <div class="stat-card"><div class="num" id="br-dlq">${b ? b.deadLetter : '—'}</div><div class="lbl">Dead-letter depth</div></div>
      <div class="stat-card"><div class="num">${ob.pending}</div><div class="lbl">Outbox pending</div></div>
      <div class="stat-card"><div class="num">${(br.queued ?? 0) + (br.published ?? 0)}</div><div class="lbl">Realm effects accepted for delivery</div></div>
    </div>
    <div class="detail">
      <h3 style="margin-top:0;">Driver matrix</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">${driverPills}</div>
      <div style="font-size:12px;color:var(--muted);">SDK-backed drivers (rabbitmq · nats · sqs-sns · pubsub · event-hubs) lazy-load their optional SDK — install the dep + set the <code>HH_*</code> env to activate.</div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Realm → broker bridge</h3>
      <div class="kv" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
        <div><div class="k">Realms attached</div><div class="v" style="font-weight:600;">${br.attached}</div></div>
        <div><div class="k">Effects projected</div><div class="v" style="font-weight:600;">${br.projected}</div></div>
        <div><div class="k">Queued (durable)</div><div class="v" style="font-weight:600;color:var(--good);">${br.queued ?? 0}</div></div>
        <div><div class="k">Failed</div><div class="v" style="font-weight:600;color:${br.failed ? 'var(--bad)' : 'var(--good)'};">${br.failed}</div></div>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:10px;">Every realm created via <em>Realm</em> attaches its effect ledger to the broker — each <code>EmittedEffect</code> becomes a <code>CanonicalEvent</code> and is published (durably via the outbox).</p>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Outbox + replay</h3>
      <div class="field-row">
        <div class="field"><label>Outbox pending / delivered / dead</label><span style="font-weight:600;">${ob.pending} / ${ob.delivered} / ${ob.dead}</span></div>
        <div class="field"><label>Replay events delivered after</label><input id="br-since" type="datetime-local" step="1" value="${esc(toDatetimeLocal(brokerSince))}" /><div class="muted" style="font-size:11px;">Local time · blank replays from epoch</div></div>
        <div class="field" style="align-self:flex-end;"><button id="br-replay" class="btn">Replay delivered → broker</button></div>
      </div>
      <div id="br-replay-out" style="margin-top:8px;font-size:12px;"></div>
    </div>
  `;
  document.getElementById('br-since')?.addEventListener('input', (e) => { brokerSince = e.target.value; });
  document.getElementById('br-replay')?.addEventListener('click', async () => {
    const out = document.getElementById('br-replay-out');
    const sinceISO = datetimeLocalToISO(brokerSince);
    try {
      const res = await fetch('/admin/broker/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(sinceISO ? { since: sinceISO } : {}) }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      out.innerHTML = `<span style="color:var(--good);">Republished ${j.republished} delivered event(s) since <code>${esc(j.since)}</code>.</span>`;
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  });
}
