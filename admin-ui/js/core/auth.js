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

import { S } from '../state.js';
import { esc, hydrateIcons } from './theme.js';

export async function checkAuth() {
  // A 401 is a definitive "you are anonymous"; anything else (network refused,
  // 5xx, a dev-server reload) is "cannot tell yet". Both consoles share one
  // hh_session cookie, so treating a transient failure as anonymous made a
  // reload look like the other console (/exec) had invalidated the login.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 600));
    try {
      const res = await fetch('/auth/me', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) return null;
      if (!res.ok) continue;
      const payload = await res.json();
      return payload && payload.authenticated ? payload.user : null;
    } catch { /* unreachable — retry */ }
  }
  return null;
}

export async function logout() {
  await rawJson('POST', '/auth/logout');
  S.sessionUser = null;
  location.reload();
}

export async function rawJson(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    return await res.json().catch(() => ({}));
  } catch (e) { return { error: String(e) }; }
}

export function renderTopbarUser() {
  const host = document.getElementById('topbar-user');
  if (!host) return;
  if (!S.sessionUser) { host.innerHTML = ''; return; }
  const initials = (S.sessionUser.displayName || S.sessionUser.username || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  host.innerHTML = `
    <span class="user-chip" title="Signed in as ${esc(S.sessionUser.username)}"><span class="user-avatar">${esc(initials)}</span>
      <span class="user-meta"><span class="user-name">${esc(S.sessionUser.displayName || S.sessionUser.username)}</span><span class="user-role">${esc(S.sessionUser.role || '')}</span></span>
    </span>
    <button class="logout-btn" id="logout-btn" title="Sign out"><i data-lucide="log-out"></i> Sign out</button>`;
  const b = document.getElementById('logout-btn');
  if (b) b.addEventListener('click', () => logout());
  // Only admins get the topbar Admin (→ Settings) shortcut; restricted roles
  // would be bounced back by the view guard anyway, so hide it for clarity.
  const adminBtn = document.getElementById('admin-settings-btn');
  if (adminBtn) adminBtn.style.display = S.sessionUser.role === 'admin' ? '' : 'none';
  if (window.hydrateIcons) window.hydrateIcons();
}
