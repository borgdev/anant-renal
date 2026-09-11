import { S } from '../state.js';
import { NAV } from './nav.js';
import { esc, hydrateIcons } from './theme.js';

export function renderPageTabs() {
  const tabsEl = document.getElementById('page-tabs');
  if (!tabsEl) return;
  const group = tabbedSectionForView(S.currentView);
  if (!group) { tabsEl.style.display = 'none'; tabsEl.innerHTML = ''; return; }
  tabsEl.style.display = '';
  tabsEl.innerHTML = tabStripHTML(group);
  if (window.hydrateIcons) window.hydrateIcons();
}

export function tabStripHTML(group) {
  return group.items.map((it) => {
    const active = S.currentView === it.view ? ' active' : '';
    const count = it.count ? `<span class="count" id="${it.count}">—</span>` : '';
    return `<button class="tab${active}" data-view="${esc(it.view)}" title="${esc(it.label)}"><i data-lucide="${esc(it.icon)}"></i><span>${esc(it.label)}</span>${count}</button>`;
  }).join('');
}

export function tabbedSectionForView(view) {
  return NAV.find((g) => g.tabbed && g.items.some((it) => it.view === view)) || null;
}
