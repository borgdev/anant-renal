import { api } from './api.js';
import { main } from './shell.js';
import { esc, hydrateIcons } from './theme.js';

export function currentYearPeriod() {
  const y = new Date().getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

export function datetimeLocalToISO(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function humanMs(ms) {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(d / 365)}y`;
}

export async function renderSummary() {
  const [s, realms, broker, audit] = await Promise.all([
    api('GET', '/admin/summary'),
    api('GET', '/admin/realms').catch(() => ({ realms: [] })),
    api('GET', '/admin/broker').catch(() => null),
    api('GET', '/admin/audit?limit=8').catch(() => ({ audit: [] })),
  ]);
  const realmList = realms.realms || [];
  const totalPresences = realmList.reduce((a, r) => a + (r.presences || 0), 0);
  const totalEffects = realmList.reduce((a, r) => a + (r.effects || 0), 0);
  const ob = broker?.outbox ?? { pending: 0, delivered: 0 };
  const br = broker?.bridge ?? { published: 0 };
  const auditRows = audit.audit || [];
  const packRows = Object.entries(s.agents.byPack).map(([k, v]) => `<div class="pack-row"><code>${esc(k)}</code><span class="pack-count">${v} agent${v === 1 ? '' : 's'}</span></div>`).join('');
  const catalogRows = [
    { label: 'Published agents', count: s.agents.total, target: 'agents', icon: 'users', color: 'var(--brand)' },
    { label: 'CMS measures wired', count: s.measures.total, target: 'measures', icon: 'file-pen-line', color: 'var(--warn)' },
    { label: 'Validated assessments', count: s.assessments.total, target: 'assessments', icon: 'clipboard-list', color: 'var(--accent)' },
    { label: 'Lifecycle stages', count: s.lifecycleStages, target: 'lifecycle', icon: 'route', color: 'var(--brand-2)' },
    { label: 'Knowledge sources', count: s.researchSources, target: 'research', icon: 'library', color: 'var(--good)' },
  ].map((c) => `<div class="catalog-row" onclick="goTo('${c.target}')" title="Open ${esc(c.label)}"><span class="catalog-icon" style="background:color-mix(in srgb,${c.color} 14%,transparent);color:${c.color};"><i data-lucide="${c.icon}"></i></span><span class="catalog-label">${esc(c.label)}</span><span class="catalog-count">${c.count}</span><span class="catalog-arrow"><i data-lucide="chevron-right" style="width:14px;height:14px;"></i></span></div>`).join('');
  const activity = [
    ...auditRows.slice(0, 8).map((a) => ({
      at: a.occurredAt || '',
      icon: a.action === 'publish' ? 'badge-check' : a.action === 'reject' ? 'x-circle' : 'pen-line',
      color: a.action === 'publish' ? 'var(--good)' : a.action === 'reject' ? 'var(--bad)' : 'var(--brand)',
      text: `<code>${esc(a.action || '')}</code> <span class="muted">${esc(a.actorRef || '')}</span> on <code>${esc(a.resourceType || a.resource || '')}</code>`,
    })),
    ...realmList.filter((r) => (r.effects || 0) > 0).slice(0, 6).map((r) => ({
      at: r.realmAt || '',
      icon: 'activity',
      color: 'var(--accent)',
      text: `<code>${esc(r.id)}</code> · ${r.effects} effect${r.effects === 1 ? '' : 's'} · ${r.presences || 0} presence${r.presences === 1 ? '' : 's'}`,
    })),
  ].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 8);
  main.innerHTML = `
    <div class="page-header">
      <div><h2 class="page-title">Operator dashboard</h2><p class="page-sub">Governed agents, measures, workflows, and live simulation activity across your organization.</p></div>
      <button class="btn btn-primary" onclick="goTo('new')"><i data-lucide="plus"></i> Create agent</button>
    </div>

    <!-- KPI cards -->
    <div class="cards kpi-grid">
      <div class="stat-card dash-kpi" onclick="goTo('agents')" title="Open Published agents"><span class="kpi-icon" style="background:color-mix(in srgb,var(--brand) 15%,transparent);color:var(--brand);"><i data-lucide="users"></i></span><div class="num">${s.agents.total}</div><div class="lbl">Published agents</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('measures')" title="Open CMS measure catalog"><span class="kpi-icon" style="background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn);"><i data-lucide="file-pen-line"></i></span><div class="num">${s.measures.total}</div><div class="lbl">CMS measures wired</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('assessments')" title="Open Validated assessments"><span class="kpi-icon" style="background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);"><i data-lucide="clipboard-list"></i></span><div class="num">${s.assessments.total}</div><div class="lbl">Validated assessments</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('lifecycle')" title="Open Patient lifecycle"><span class="kpi-icon" style="background:color-mix(in srgb,var(--brand-2) 15%,transparent);color:var(--brand-2);"><i data-lucide="route"></i></span><div class="num">${s.lifecycleStages}</div><div class="lbl">Lifecycle stages</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('research')" title="Open Knowledge sources"><span class="kpi-icon" style="background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good);"><i data-lucide="library"></i></span><div class="num">${s.researchSources}</div><div class="lbl">Knowledge sources</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('realm')" title="Open Realm management"><span class="kpi-icon" style="background:color-mix(in srgb,var(--violet) 15%,transparent);color:var(--violet);"><i data-lucide="building-2"></i></span><div class="num">${realmList.length}</div><div class="lbl">Realms</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('realm')" title="Open Realm management"><span class="kpi-icon" style="background:color-mix(in srgb,var(--blue) 15%,transparent);color:var(--blue);"><i data-lucide="bot"></i></span><div class="num">${totalPresences}</div><div class="lbl">Presences</div></div>
      <div class="stat-card dash-kpi" onclick="goTo('realm')" title="Open Realm management"><span class="kpi-icon" style="background:color-mix(in srgb,var(--mint) 15%,transparent);color:var(--mint-strong);"><i data-lucide="scroll-text"></i></span><div class="num">${totalEffects}</div><div class="lbl">Effects</div></div>
    </div>

    <!-- Live simulation + Catalog -->
    <div class="dash-grid">
      <div class="dash-card">
        <div class="dash-card-head"><h3><i data-lucide="radio"></i> Live simulation</h3><a class="btn btn-ghost" style="height:26px;padding:0 10px;" onclick="goTo('realm')" title="Open Realm management"><i data-lucide="arrow-up-right" style="width:13px;height:13px;"></i> Open</a></div>
        <div class="dash-card-body">
          <div class="mini-grid">
            <div class="mini-stat"><strong>${realmList.length}</strong><small>Realms</small></div>
            <div class="mini-stat"><strong>${totalPresences}</strong><small>Presences</small></div>
            <div class="mini-stat"><strong>${totalEffects}</strong><small>Effects</small></div>
            <div class="mini-stat"><strong>${(br.queued ?? 0) + (br.published ?? 0)}</strong><small>Effects queued</small></div>
            <div class="mini-stat"><strong>${ob.pending ?? 0}</strong><small>Outbox pending</small></div>
            <div class="mini-stat"><strong>${auditRows.length > 0 ? 'live' : '—'}</strong><small>Audit stream</small></div>
          </div>
          ${realmList.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">${realmList.map((r) => `<button class="btn btn-ghost" style="font-size:12px;padding:3px 10px;" onclick="realmDeepLink='${esc(r.id)}';goTo('realm')" title="Open ${esc(r.id)} in Realm management"><i data-lucide="building-2" style="width:13px;height:13px;"></i> ${esc(r.id)}</button>`).join('')}</div>` : ''}
        </div>
      </div>
      <div class="dash-card">
        <div class="dash-card-head"><h3><i data-lucide="library-big"></i> Catalog</h3></div>
        <div class="dash-card-body">${catalogRows}</div>
      </div>
    </div>

    <!-- Packs + Recent activity -->
    <div class="dash-grid">
      <div class="dash-card">
        <div class="dash-card-head"><h3><i data-lucide="package"></i> Packs</h3><span class="pill muted">${Object.keys(s.agents.byPack).length} packs</span></div>
        <div class="dash-card-body">${packRows.length ? packRows : '<div class="muted" style="font-size:13px;">No packs installed.</div>'}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-head"><h3><i data-lucide="activity"></i> Recent activity</h3></div>
        <div class="dash-card-body">
          ${activity.length === 0 ? '<div class="muted" style="font-size:13px;">No activity yet — create a realm and tick it, or audit some events.</div>' : activity.map((a) => `<div class="activity-row"><span class="activity-icon" style="color:${a.color};"><i data-lucide="${a.icon}" style="width:14px;height:14px;"></i></span><span class="activity-text">${a.text}</span><span class="activity-time">${a.at ? new Date(a.at).toLocaleString() : ''}</span></div>`).join('')}
        </div>
      </div>
    </div>
  `;
  if (window.hydrateIcons) window.hydrateIcons();
}

export function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
