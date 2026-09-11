export function applyTheme(t) {
  const next = t === 'light' ? 'light' : 'dark';
  const root = document.documentElement;
  root.dataset.theme = next;
  root.classList.toggle('dark', next === 'dark');
  try { localStorage.setItem('hh-theme', next); } catch (_) {}
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.title = next === 'dark' ? 'Theme: Dark — switch to light' : 'Theme: Light — switch to dark';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = next === 'dark' ? '<i data-lucide="sun" style="width:16px;height:16px;"></i>' : '<i data-lucide="moon" style="width:16px;height:16px;"></i>';
  }
  if (window.lucide) window.lucide.createIcons();
}

export function copyToClipboard(text) {
  try {
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'good')).catch(() => toast('Copy failed', 'err'));
  } catch { toast('Copy failed', 'err'); }
}

export function dataGrid(opts) { return window.__dataGrid ? window.__dataGrid(opts) : fallbackGrid(opts); }

export function downloadBlob(name, type, text) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

export function fallbackGrid(opts) {
  const root = typeof opts.el === 'string' ? document.getElementById(opts.el) : opts.el;
  if (!root) return null;
  let data = opts.data || [];
  let q = ''; let sort = null; let dir = 1;
  const cols = opts.columns || [];
  const fmtF = (v) => (v === null || v === undefined || v === '') ? '—' : String(v);
  const render = () => {
    let rows = data;
    if (q) { const t = q.toLowerCase(); rows = rows.filter(r => cols.some(c => String(r[c.key] ?? '').toLowerCase().includes(t))); }
    if (sort) { const k = sort; rows = [...rows].sort((a, b) => { const x = a[k] ?? '', y = b[k] ?? ''; const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return c * dir; }); }
    const head = '<tr>' + cols.map(c => `<th class="${c.sortable !== false ? 'dg-sortable' : ''}" data-k="${c.key}" style="text-align:${c.align || 'left'}">${esc(c.label || c.key)}${sort === c.key ? (dir === 1 ? ' <span class="dg-arrow">▲</span>' : ' <span class="dg-arrow">▼</span>') : ''}</th>`).join('') + '</tr>';
    const body = rows.length === 0 ? `<tr><td colspan="${cols.length}" class="dg-empty">${esc(opts.empty || 'No records.')}</td></tr>` : rows.map(r => '<tr>' + cols.map(c => `<td style="text-align:${c.align || 'left'}">${c.render ? c.render(r[c.key], r) : fmtF(r[c.key])}</td>`).join('') + '</tr>').join('');
    root.innerHTML = `<div class="dg">
      <div class="dg-toolbar"><div class="dg-search"><input placeholder="Search…" value="${esc(q)}"></div><div class="dg-tools"><span class="dg-count">Showing ${rows.length} of ${data.length}</span></div></div>
      <div class="dg-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
    </div>`;
    const inp = root.querySelector('.dg-search input'); if (inp) inp.addEventListener('input', e => { q = e.target.value; render(); });
    root.querySelectorAll('th.dg-sortable').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; if (sort === k) dir *= -1; else { sort = k; dir = 1; } render(); }));
    if (window.hydrateIcons) window.hydrateIcons();
  };
  render();
  return { refresh(d) { data = d; render(); } };
}

export function hydrateIcons() { if (window.lucide) window.lucide.createIcons(); }

export function initTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

export function toast(msg, kind='') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000); }
