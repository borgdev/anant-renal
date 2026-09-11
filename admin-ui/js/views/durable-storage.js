import { api } from '../core/api.js';
import { main } from '../core/shell.js';
import { dataGrid, esc } from '../core/theme.js';

export async function renderDurableStorage() {
  const [realms, billing, cfs] = await Promise.all([
    api('GET', '/admin/sql/realms'),
    api('GET', '/admin/sql/billing'),
    api('GET', '/admin/sql/counterfactuals'),
  ]);
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Durable storage</h2>
      <p class="page-sub">Realms, billing, counterfactual runs, and the nudge ledger persisted through the swappable SqlDb seam — SQLite by default, swap for Postgres via HH_STORAGE without touching application code.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${(realms.realms || []).length}</div><div class="lbl">Realm snapshots</div></div>
      <div class="stat-card"><div class="num">${(billing.billing || []).length}</div><div class="lbl">Billing meter reads</div></div>
      <div class="stat-card"><div class="num">${(cfs.runs || []).length}</div><div class="lbl">Counterfactual runs</div></div>
      <div class="stat-card"><div class="num">${(realms.realms || []).reduce((a, r) => a + (r.snapshotJson || '').length, 0)}</div><div class="lbl">Snapshot bytes</div></div>
    </div>
    <div class="detail"><h3 style="margin-top:0;">Realm snapshots</h3><div id="ds-realms-grid"></div></div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Billing usage</h3><div id="ds-billing-grid"></div></div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Counterfactual runs</h3><div id="ds-cf-grid"></div></div>
    <div class="detail" style="margin-top:12px;font-size:12px;color:var(--muted);">
      <strong>Swap story:</strong> the store layer writes only portable SQL against the <code>SqlDb</code> seam.
      <code>HH_STORAGE=postgres</code> + <code>HH_DATABASE_URL</code> swaps the adapter; nothing else changes.
    </div>
  `;
  dataGrid({
    el: 'ds-realms-grid', filename: 'sql-realms', empty: 'No snapshots persisted yet — create or tick a realm.',
    columns: [
      { key: 'realmId', label: 'Realm', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'mode', label: 'Mode', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
      { key: 'createdAt', label: 'Created' }, { key: 'updatedAt', label: 'Updated' },
      { key: 'bytes', label: 'Size', align: 'right', render: (v) => `${esc(v)} bytes` },
    ],
    data: (realms.realms || []).map(r => ({ ...r, bytes: (r.snapshotJson || '').length })),
  });
  dataGrid({
    el: 'ds-billing-grid', filename: 'sql-billing', pageSize: 10, empty: 'No meter reads yet — open a realm billing view.',
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'realmId', label: 'Realm' }, { key: 'period', label: 'Period' },
      { key: 'plan', label: 'Plan', render: (v) => `<span class="pill brand">${esc(v)}</span>` },
      { key: 'createdAt', label: 'Created' },
    ],
    data: (billing.billing || []),
  });
  dataGrid({
    el: 'ds-cf-grid', filename: 'sql-counterfactuals', empty: 'No counterfactual runs persisted yet — run one from the studio.',
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'label', label: 'Label' },
      { key: 'realmId', label: 'Realm', render: (v) => esc(v || '—') },
      { key: 'createdAt', label: 'Created' },
    ],
    data: (cfs.runs || []),
  });
}
