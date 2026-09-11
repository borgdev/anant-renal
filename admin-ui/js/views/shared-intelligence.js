import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export async function renderPlatformCanvases() {
  let canvases = [];
  try { canvases = (await plFetch('GET', '/api/canvases')).canvases || []; } catch (e) { /* ignore */ }
  let graph = { nodes: [], edges: [] };
  try { graph = await plFetch('GET', '/api/graph'); } catch (e) { /* ignore */ }
  const rows = canvases.map((c) => `
    <div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--border);flex-wrap:wrap;">
      <span style="flex:1;min-width:160px;font-size:13px;"><b>${esc(c.name)}</b> <span class="muted" style="font-size:11px;">· ${esc(c.scopeId)} · v${c.version}</span></span>
      <span class="muted" style="font-size:11px;">${(c.nodes || []).length} nodes · ${(c.edges || []).length} edges · ${(c.notes || []).length} notes</span>
      <span style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="plCanvasOpen('${esc(c.id)}')">Open</button>
        <button class="btn btn-sm" onclick="plCanvasAction('${esc(c.id)}','note')">Note</button>
        <button class="btn btn-sm" onclick="plCanvasAction('${esc(c.id)}','simulate')">What-if</button>
      </span>
    </div>`).join('') || '<div class="muted">No canvases yet — create one to bind typed graph insight.</div>';

  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Shared Intelligence</h2>
      <p class="page-sub">Journey O — server-backed canvases over the typed hypergraph: saved scope, versioned notes with citations, and an isolated what-if entry that becomes a cited work/release decision.</p></div></div>
    <div class="detail">
      <h3 style="margin-top:0;">Canvases</h3>
      <button class="btn btn-primary" onclick="plCanvasAction('none','create')">New canvas</button>
      <div id="pl-canvas-list" style="margin-top:10px;">${rows}</div>
      <div id="pl-canvas-detail" style="margin-top:12px;"></div>
    </div>`;
}
