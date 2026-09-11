import { api } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export const HG_COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#4ade80', '#fb923c', '#e879f9', '#22d3ee', '#a3e635', '#facc15', '#c084fc'];

export let hgRealm = '';

export async function loadHypergraph() {
  const wrap = document.getElementById('hg-svg-wrap');
  if (!wrap || !hgRealm) return;
  wrap.innerHTML = '<div style="padding:20px;color:var(--muted);">Loading…</div>';
  try {
    const g = await api('GET', `/admin/hypergraph/realm/${encodeURIComponent(hgRealm)}/graph`);
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    if (nodes.length === 0) { wrap.innerHTML = '<div style="padding:20px;color:var(--muted);">No nodes yet — emit effects or ingest FHIR into this realm.</div>'; return; }
    renderHgSvg(wrap, g, nodes, edges);
  } catch (err) { wrap.innerHTML = `<div style="padding:20px;color:var(--bad);">${esc(String(err))}</div>`; }
}

export function renderHgSvg(wrap, g, nodes, edges) {
  // deterministic concentric layout: one ring per node type
  const types = [...new Set(nodes.map((n) => n.type))];
  const colorOf = (t) => HG_COLORS[Math.max(0, types.indexOf(t)) % HG_COLORS.length];
  const byType = {};
  nodes.forEach((n) => { (byType[n.type] = byType[n.type] || []).push(n); });
  const pos = {};
  const pad = 60, ringR = 90, gap = 46;
  const W = pad * 2 + types.length * ringR * 2 + (types.length - 1) * gap;
  const H = Math.max(420, pad * 2 + ringR * 2 + 60);
  types.forEach((t, ti) => {
    const cx = pad + ringR + ti * (ringR * 2 + gap);
    const cy = H / 2;
    const arr = byType[t] || [];
    arr.forEach((n, i) => {
      const ang = (i / Math.max(1, arr.length)) * Math.PI * 2 - Math.PI / 2;
      pos[n.id] = { x: cx + Math.cos(ang) * ringR, y: cy + Math.sin(ang) * ringR };
    });
  });
  const short = (id) => id.length > 26 ? id.slice(0, 23) + '…' : id;
  const edgePaths = edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return '';
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--border)" stroke-width="1" opacity="0.6"><title>${esc(e.type)}</title></line>`;
  }).join('');
  const nodeEls = nodes.map((n) => {
    const p = pos[n.id];
    if (!p) return '';
    const label = n.type === 'realm' ? n.attributes.realmId : (n.attributes[n.type + 'Id'] ?? n.attributes.id ?? n.id);
    return `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" data-node="${esc(n.id)}" style="cursor:pointer;">
      <circle r="11" fill="${colorOf(n.type)}" stroke="var(--bg)" stroke-width="2"><title>${esc(n.type)}</title></circle>
      <text y="26" text-anchor="middle" font-size="9" fill="var(--fg)">${esc(short(String(label)))}</text>
    </g>`;
  }).join('');
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:var(--bg);" xmlns="http://www.w3.org/2000/svg">${edgePaths}${nodeEls}</svg>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">${types.map((t) => `<span style="font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:4px;"><span style="width:9px;height:9px;border-radius:50%;background:${colorOf(t)};display:inline-block;"></span>${esc(t)}</span>`).join('')}</div>
    <div style="margin-top:4px;font-size:11px;color:var(--muted);">${nodes.length} nodes · ${edges.length} edges · ${g.live ? 'live bridge' : 'cold materialize'}</div>`;
  wrap.querySelectorAll('[data-node]').forEach((el) => el.addEventListener('click', () => {
    const node = nodes.find((n) => n.id === el.dataset.node);
    if (!node) return;
    const attrs = Object.entries(node.attributes || {}).map(([k, v]) => `<div style="display:flex;gap:8px;"><span style="color:var(--muted);min-width:130px;">${esc(k)}</span><code>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</code></div>`).join('');
    document.getElementById('hg-detail').innerHTML = `<div style="font-weight:600;color:var(--fg);">${esc(node.type)} <code>${esc(node.id)}</code></div>${attrs || '<div>no attributes</div>'}`;
  }));
}

export async function renderHypergraphBrowser() {
  const realms = await api('GET', '/admin/realms').catch(() => ({ realms: [] }));
  const ids = (realms.realms || []).map((r) => r.id);
  if (!hgRealm || !ids.includes(hgRealm)) hgRealm = ids[0] || '';
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Hypergraph</h2>
      <p class="page-sub">The realm's live entity graph — nodes and edges projected by every effect (Phase 1b bridge).</p></div>
      <div class="field-row" style="min-width:280px;">
        <div class="field"><label>Realm</label><select id="hg-realm">${ids.map((id) => `<option value="${esc(id)}" ${id === hgRealm ? 'selected' : ''}>${esc(id)}</option>`).join('') || '<option value="">no realms</option>'}</select></div>
        <div class="field"><button id="hg-refresh" class="btn">Refresh</button></div>
      </div></div>
    <div class="detail"><div id="hg-svg-wrap" style="overflow:auto;max-height:72vh;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--bg);"></div></div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Node detail</h3><div id="hg-detail" style="font-size:12px;color:var(--muted);">Select a node to inspect its attributes.</div></div>
  `;
  document.getElementById('hg-realm')?.addEventListener('change', (e) => { hgRealm = e.target.value; loadHypergraph(); });
  document.getElementById('hg-refresh')?.addEventListener('click', () => renderHypergraphBrowser());
  await loadHypergraph();
}
