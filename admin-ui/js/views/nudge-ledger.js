import { api, consoleDomain } from '../core/api.js';
import { loadPatientDatalist } from '../core/search.js';
import { main } from '../core/shell.js';
import { copyToClipboard, dataGrid, downloadBlob, esc } from '../core/theme.js';

export async function nlObserve(id) {
  const outcome = prompt('Observed outcome (JSON), e.g. {"phosphate":0.4}');
  if (outcome === null) return;
  let parsed = {}; try { parsed = JSON.parse(outcome); } catch { /* keep {} */ }
  await fetch('/admin/nudges/' + encodeURIComponent(id) + '/observe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: parsed }) });
  renderNudgeLedger();
}

export async function renderNudgeLedger() {
  const dom = await consoleDomain();
  const realms = await api('GET', '/admin/realms');
  const realmOptions = (realms.realms || []).map(r => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('') || '<option value="">(no realms yet)</option>';
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Nudge ledger</h2>
      <p class="page-sub">Deliver a rehearsed nudge through a real-world channel, then close the loop when the patient's response is observed.
      Every row is persisted to the swappable SQL store, so the ledger survives restarts.</p></div></div>
    <div class="detail" style="margin-top:0;"><div class="field-row">
      <label class="field"><span>Realm</span><select id="nl-realm">${realmOptions}</select></label>
      <label class="field"><span>Patient</span><input id="nl-patient" placeholder="patient-001" list="nl-patient-list" style="width:150px"><datalist id="nl-patient-list"></datalist></label>
      <label class="field"><span>Channel</span><select id="nl-channel">${(dom.nudgeDefault.channels || []).map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
      <label class="field"><span>Nudge kind</span><input id="nl-kind" value="${esc(dom.nudgeDefault.kind)}" style="width:150px"></label>
      <label class="field"><span>Expected effect</span><input id="nl-effect" value='${JSON.stringify(dom.nudgeDefault.expectedEffect).replace(/'/g, '&#39;')}' style="width:230px"></label>
      <button class="btn btn-primary" id="nl-deliver"><i data-lucide="send"></i> Deliver</button>
    </div></div>
    <div id="nl-table"></div>`;
  const nlRealm = document.getElementById('nl-realm');
  const nlPatients = async () => loadPatientDatalist(nlRealm.value, 'nl-patient-list');
  nlRealm.addEventListener('change', nlPatients);
  nlPatients();
  let grid = null;
  const load = async () => {
    const d = await api('GET', '/admin/nudges');
    if (!grid) {
      grid = dataGrid({
        el: 'nl-table', filename: 'nudges', pageSize: 15, empty: 'No nudges delivered yet.',
        selectable: true, idKey: 'id',
        bulkActions: [
          { label: 'Export selected JSON', onClick(rows) { downloadBlob('nudges-selected.json', 'application/json', JSON.stringify(rows, null, 2)); } },
          { label: 'Copy IDs', onClick(rows) { copyToClipboard(rows.map((r) => r.id || '').filter(Boolean).join('\n')); } },
        ],
        columns: [
          { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'realmId', label: 'Realm' },
          { key: 'patientId', label: 'Patient' },
          { key: 'channel', label: 'Channel' },
          { key: 'nudgeKind', label: 'Kind', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'status', label: 'Status', render: (v) => `<span class="pill ${v==='observed'?'good':v==='delivered'?'brand':'muted'}">${esc(v)}</span>` },
          { key: 'rehearsalId', label: 'Rehearsal', render: (v) => esc(v || '—') },
          { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => r.status === 'delivered' ? `<button class="btn" onclick="nlObserve('${esc(r.id)}')">Observe</button>` : '' },
        ],
        data: (d.nudges || []),
      });
    } else {
      grid.refresh(d.nudges || []);
    }
  };
  document.getElementById('nl-deliver')?.addEventListener('click', async () => {
    let effect = {};
    try { effect = JSON.parse(document.getElementById('nl-effect').value || '{}'); } catch { effect = {}; }
    await fetch('/admin/nudges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      realmId: document.getElementById('nl-realm').value, patientId: document.getElementById('nl-patient').value,
      channel: document.getElementById('nl-channel').value, nudgeKind: document.getElementById('nl-kind').value,
      expectedEffect: effect,
    }) });
    load();
  });
  load();
}
