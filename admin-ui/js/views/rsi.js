import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export function renderRsiApp() {
  const RSI_URL = 'http://localhost:5173/';
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Renal Swarm Intelligence</h2>
        <p class="page-sub">The governed clinical and operational product for renal care. Clinical screens, outcome command, patient intelligence and regulatory workflows live in this application.</p>
      </div>
    </div>
    <div class="state-card" style="padding:28px 24px;max-width:700px;border-color:color-mix(in srgb, var(--partner-accent) 18%, transparent);background:linear-gradient(110deg,color-mix(in srgb, var(--partner-accent) 5%, transparent),color-mix(in srgb, var(--blue) 2.5%, transparent));">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
        <span style="width:48px;height:48px;display:grid;place-items:center;border-radius:14px;color:var(--partner-accent);background:color-mix(in srgb, var(--partner-accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--partner-accent) 20%, transparent);font-size:22px;">⬡</span>
        <div>
          <div class="state-title" style="margin:0 0 4px;">Renal Swarm Intelligence</div>
          <div class="state-sub" style="margin:0;font-size:12px;">Governed agentic outcome harness · v0.9.0</div>
        </div>
        <a href="${RSI_URL}" target="_blank" rel="noreferrer" style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:1px solid color-mix(in srgb, var(--partner-accent) 25%, transparent);border-radius:9px;background:color-mix(in srgb, var(--partner-accent) 9%, transparent);color:var(--partner-accent-soft);font-size:12px;font-weight:700;text-decoration:none;" onclick="window.open('${RSI_URL}','_blank');return false;">
          Open app <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px;">
        <div style="padding:11px;border:1px solid var(--border);border-radius:8px;">
          <div class="muted" style="font-size:11px;margin-bottom:4px;">Screens</div>
          <strong>12 modules</strong><br><span class="muted" style="font-size:11px;">Command · Patient · Agents + 9 more</span>
        </div>
        <div style="padding:11px;border:1px solid var(--border);border-radius:8px;">
          <div class="muted" style="font-size:11px;margin-bottom:4px;">Data regime</div>
          <strong style="color:#c9bbff;">Synthetic demo</strong><br><span class="muted" style="font-size:11px;">Connect via Platform setup</span>
        </div>
        <div style="padding:11px;border:1px solid var(--border);border-radius:8px;">
          <div class="muted" style="font-size:11px;margin-bottom:4px;">Runtime</div>
          <strong style="color:var(--partner-accent);">12 agents active</strong><br><span class="muted" style="font-size:11px;">14 policies · 8 sources</span>
        </div>
      </div>
      <div style="padding:13px;border:1px solid var(--border);border-radius:9px;background:color-mix(in srgb, var(--elevate) 2%, transparent);margin-bottom:14px;">
        <div style="font-weight:700;font-size:12px;margin-bottom:8px;">What lives in RSI</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;">
          ${['Outcome command (FA daily worklist)','Patient intelligence','Assessment intelligence','Facility operations & capacity','Swarm control (enterprise monitoring)','Agent operations','Shared intelligence graph','Executive outcomes','CMS operations','AI assurance & red-teaming','Configuration studio','Platform admin / onboarding'].map(s=>`<div style="display:flex;align-items:center;gap:7px;font-size:12px;padding:3px 0;"><span style="width:5px;height:5px;border-radius:50%;background:var(--partner-accent);flex:0 0 auto;"></span>${esc(s)}</div>`).join('')}
        </div>
      </div>
      <div style="padding:11px;border:1px solid color-mix(in srgb, var(--amber) 20%, transparent);border-radius:9px;background:color-mix(in srgb, var(--amber) 5%, transparent);display:flex;gap:10px;align-items:flex-start;">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;margin-top:1px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style="font-size:12px;color:#c8a85a;">To connect a live organization, complete the <strong>Platform setup</strong> steps under <strong>Platform → Onboarding</strong> in this console. RSI will display a live-data banner once the release is activated.</span>
      </div>
    </div>
  `;
}

export function renderRsiDeepLink(screen, label) {
  const url = `http://localhost:5173/`;
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">${esc(label)}</h2>
        <p class="page-sub">This view lives in <strong>Renal Swarm Intelligence</strong> — the governed clinical product. It is role-aware and context-sensitive; open RSI to see it with the full operational context.</p>
      </div>
    </div>
    <div class="state-card" style="padding:24px;max-width:560px;border-color:color-mix(in srgb, var(--partner-accent) 18%, transparent);background:linear-gradient(110deg,color-mix(in srgb, var(--partner-accent) 4%, transparent),color-mix(in srgb, var(--blue) 2%, transparent));">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
        <span style="width:40px;height:40px;display:grid;place-items:center;border-radius:12px;color:var(--partner-accent);background:color-mix(in srgb, var(--partner-accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--partner-accent) 18%, transparent);font-size:18px;">⬡</span>
        <div>
          <div style="font-weight:700;font-size:14px;margin-bottom:3px;">${esc(label)}</div>
          <div class="muted" style="font-size:12px;">Owned by Renal Swarm Intelligence</div>
        </div>
      </div>
      <p style="font-size:12px;color:var(--muted);line-height:1.65;margin:0 0 18px;">This screen is authoritative in RSI where it is rendered with live role context, org scope, and integrated navigation. Opening RSI will land you on this view if your role has it as a primary screen.</p>
      <a href="${url}" target="_blank" rel="noreferrer" style="display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border:1px solid color-mix(in srgb, var(--partner-accent) 25%, transparent);border-radius:9px;background:color-mix(in srgb, var(--partner-accent) 9%, transparent);color:var(--partner-accent-soft);font-size:13px;font-weight:700;text-decoration:none;">
        Open RSI
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
    </div>
  `;
}
