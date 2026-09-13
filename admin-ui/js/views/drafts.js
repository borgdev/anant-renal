/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

import { api, drafts } from '../core/api.js';
import { goTo, render } from '../core/router.js';
import { toast } from '../core/theme.js';

// js-yaml ships as a UMD bundle loaded from a CDN by admin-ui/index.html before
// this module executes, so there is no ES module to import it from.
const jsyaml = globalThis.jsyaml;

export async function saveDraft(status) {
  const yaml = document.getElementById('yaml-editor').value;
  if (!yaml.trim()) return toast('Nothing to save', 'err');
  let doc;
  try { doc = jsyaml.load(yaml); } catch { return toast('YAML parse error', 'err'); }
  if (!doc?.id || !doc?.packId) return toast('YAML needs id and packId', 'err');
  const payload = { packId: doc.packId, id: doc.id, yaml, status };
  try {
    const res = await fetch('/admin/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) { toast(status === 'in-review' ? 'Submitted for review' : 'Draft saved', 'good'); goTo('drafts'); return; }
    const j = await res.json().catch(() => ({}));
    toast('Save failed: ' + (j.error || res.status), 'err'); return;
  } catch { /* server unreachable → local demo fallback */ }
  await api('POST', '/admin/drafts', payload);
  toast(status === 'in-review' ? 'Submitted for review' : 'Draft saved', 'good');
  goTo('drafts');
}

export async function publishDraft(packId, id) {
  const note = prompt('Publish note (optional):') || '';
  try {
    const res = await fetch(`/admin/drafts/${encodeURIComponent(packId)}/${encodeURIComponent(id)}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
    if (res.ok) { toast(`Published ${id}`, 'good'); goTo('agents'); return; }
    const j = await res.json().catch(() => ({}));
    toast('Publish failed: ' + (j.error || res.status), 'err'); return;
  } catch { /* offline → local demo fallback */ }
  const d = drafts.find(x => x.packId === packId && x.id === id);
  if (!d?.validation?.ok) return toast('Cannot publish invalid draft', 'err');
  try { await api('POST', `/admin/drafts/${packId}/${id}/publish`, { note }); toast(`Published ${id}`, 'good'); goTo('agents'); }
  catch (e) { toast('Publish failed: ' + e.message, 'err'); }
}

export async function deleteDraft(packId, id) {
  if (!confirm(`Delete draft ${id}?`)) return;
  try {
    const res = await fetch(`/admin/drafts/${encodeURIComponent(packId)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) { toast('Draft deleted', 'good'); render(); return; }
    const j = await res.json().catch(() => ({}));
    toast('Delete failed: ' + (j.error || res.status), 'err'); return;
  } catch { /* offline → local demo fallback */ }
  await api('DELETE', `/admin/drafts/${packId}/${id}`);
  toast('Draft deleted', 'good');
  render();
}
