import { esc, hydrateIcons } from './theme.js';

export const SHORTCUTS = [
  ['/ or Ctrl+K', 'Focus the global search'],
  ['?', 'Show this keyboard-shortcuts help'],
  ['r', 'Refresh the current view'],
  ['d', 'Go to Dashboard (Overview)'],
  ['a', 'Go to Agents → Published'],
  ['w', 'Go to World → Realm'],
  ['c', 'Go to Catalog → CMS measures'],
  ['g', 'Go to Governance → Compliance'],
  ['Esc', 'Close dialogs / the search box'],
];

export function shortcutsModalHTML() {
  return `<div class="modal-overlay" id="shortcuts-modal" style="z-index:90;"><div class="modal">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <h3 style="margin:0;">Keyboard shortcuts</h3>
      <button class="btn btn-ghost" id="shortcuts-close"><i data-lucide="x"></i></button>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tbody>${SHORTCUTS.map(([k, d]) => `<tr><td style="padding:5px 8px;border-bottom:1px dashed var(--border);white-space:nowrap;"><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:1px 7px;font-size:12px;font-family:ui-monospace,monospace;">${esc(k)}</kbd></td><td style="padding:5px 8px;border-bottom:1px dashed var(--border);color:var(--muted);">${esc(d)}</td></tr>`).join('')}</tbody>
    </table>
  </div></div>`;
}

export function toggleShortcuts(open) {
  const existing = document.getElementById('shortcuts-modal');
  if (open && !existing) {
    document.body.insertAdjacentHTML('beforeend', shortcutsModalHTML());
    const m = document.getElementById('shortcuts-modal');
    const close = () => m.remove();
    m.querySelector('#shortcuts-close')?.addEventListener('click', close);
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
    if (window.hydrateIcons) window.hydrateIcons();
  } else if (!open && existing) { existing.remove(); }
}
