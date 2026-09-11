import { consoleLearn } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export async function renderLearn() {
  const recipes = await consoleLearn();
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Learn</h2><p class="page-sub">Short recipes for the most common Knowledge, Realm, and Agent workflows. Each one has a scoped Run-it-now.</p></div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px">
      ${recipes.map(r => `<div class="card" style="padding:16px;border:1px solid var(--border);border-radius:8px">
        <h3 style="margin:0 0 6px">${esc(r.title)}</h3>
        <p style="color:#555">${esc(r.body)}</p>
        <button class="btn primary" onclick="nav.querySelector('[data-view=${r.action.view}]').click()">${esc(r.action.label)}</button>
      </div>`).join('')}
    </div>
  `;
}
