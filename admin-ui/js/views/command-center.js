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

import { main } from '../core/shell.js';

export let ccPaused = false;

export let ccSource = null;

export function renderCommandCenter() {
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Command center</h2>
      <p class="page-sub">Live multi-realm stream: effects, experiences, and durable webhook activity across every realm (SSE <code>/admin/stream</code>).</p></div>
      <div class="field-row">
        <div class="field"><button id="cc-pause" class="btn">Pause</button></div>
        <div class="field"><button id="cc-clear" class="btn">Clear</button></div>
      </div></div>
    <div class="detail"><div id="cc-status" style="font-size:12px;color:var(--muted);margin-bottom:6px;">Connecting…</div>
      <div id="cc-wall" style="height:64vh;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;font-family:var(--code-fg);font-size:12px;background:var(--bg);"></div></div>
  `;
  document.getElementById('cc-pause')?.addEventListener('click', () => {
    ccPaused = !ccPaused;
    document.getElementById('cc-pause').textContent = ccPaused ? 'Resume' : 'Pause';
  });
  document.getElementById('cc-clear')?.addEventListener('click', () => { document.getElementById('cc-wall').innerHTML = ''; });
  if (ccSource) ccSource.close();
  ccSource = new EventSource('/admin/stream');
  ccSource.onmessage = (e) => {
    if (ccPaused) return;
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    const wall = document.getElementById('cc-wall');
    if (!wall) return;
    const color = evt.type === 'effect' ? 'var(--good)' : evt.type === 'experience' ? 'var(--warn)' : evt.type === 'webhook' ? 'var(--brand)' : 'var(--muted)';
    let text = `${evt.at || ''} [${evt.type}]`;
    if (evt.type === 'effect') text += ` ${evt.payload?.realmId} ${evt.payload?.effect?.kind || ''}`;
    else if (evt.type === 'experience') text += ` ${evt.payload?.realmId} ${evt.payload?.type || ''}`;
    else if (evt.type === 'webhook') text += ` #${evt.payload?.webhookId} ${evt.payload?.eventId} ${evt.payload?.status}`;
    else if (evt.type === 'hello') { document.getElementById('cc-status').textContent = `Streaming ${(evt.payload?.realms || []).length} realm(s).`; text = `hello: ${(evt.payload?.realms || []).join(', ')}`; }
    else if (evt.type === 'heartbeat') { document.getElementById('cc-status').textContent = `Streaming ${evt.payload?.realms || 0} realm(s).`; return; }
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = text;
    wall.prepend(line);
    while (wall.children.length > 500) wall.lastChild.remove();
  };
  ccSource.onerror = () => { const s = document.getElementById('cc-status'); if (s) s.textContent = 'Stream disconnected — will reconnect.'; };
}
