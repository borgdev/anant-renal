import { api } from './api.js';
import { esc } from './theme.js';

export async function loadPatientDatalist(realmId, listId) {
  const dl = document.getElementById(listId);
  if (!dl || !realmId) { if (dl) dl.innerHTML = ''; return; }
  try {
    const d = await api('GET', `/admin/realms/${encodeURIComponent(realmId)}/patients`);
    dl.innerHTML = (d.patients || []).map((p) => `<option value="${esc(p.id)}">`).join('');
  } catch (_) { dl.innerHTML = ''; }
}
