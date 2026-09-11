import { S } from '../state.js';
import { updateSidebarCounts } from './scope.js';
import { nav } from './shell.js';
import { esc, hydrateIcons } from './theme.js';
import { viewAllowed } from '../views/editor.js';

export const COLLAPSE_KEY = 'hh-collapsed-sections';

export const NAV = [
  { section: 'Overview', icon: 'layout-dashboard', items: [ { view: 'summary', icon: 'layout-dashboard', label: 'Dashboard' }, { view: 'my-work', icon: 'inbox', label: 'My Work', count: 'c-mywork' } ] },
  // Observers: bounded perception-only units — they see, assess and propose. They do not act.
  { section: 'Observers', icon: 'eye', tabbed: true, items: [
    { view: 'agents', icon: 'eye', label: 'Active observers', count: 'c-agents' },
    { view: 'agent-run', icon: 'activity', label: 'Observer runtime' },
    { view: 'drafts', icon: 'file-pen-line', label: 'Draft observers', count: 'c-drafts' },
    { view: 'new', icon: 'plus', label: 'New observer' },
  ] },
  { section: 'Catalog', icon: 'book-open', tabbed: true, items: [
    { view: 'measures', icon: 'clipboard-check', label: 'CMS measures', count: 'c-measures' },
    { view: 'assessments', icon: 'clipboard-list', label: 'Assessments', count: 'c-assessments' },
    { view: 'lifecycle', icon: 'route', label: 'Patient lifecycle' },
    { view: 'research', icon: 'library', label: 'Knowledge sources', count: 'c-research' },
    { view: 'learn', icon: 'graduation-cap', label: 'Learn' },
  ] },
  // Care environment: the digital twin model — realm → participants → events → observer signals → knowledge
  { section: 'Care environment', icon: 'globe', tabbed: true, items: [
    { view: 'world-builder', icon: 'map', label: 'Environment builder' },
    { view: 'realm', icon: 'building-2', label: 'Care domain', count: 'c-realm' },
    { view: 'presences', icon: 'users', label: 'Participants', count: 'c-presences' },
    { view: 'effects', icon: 'scroll-text', label: 'Event ledger', count: 'c-effects' },
    { view: 'perception', icon: 'eye', label: 'Observer signals' },
    { view: 'experiences', icon: 'sparkles', label: 'Care encounters', count: 'c-experiences' },
    { view: 'rules', icon: 'scale', label: 'Domain rules' },
    { view: 'hypergraph', icon: 'network', label: 'Knowledge graph' },
  ] },
  // Observer reasoning: the epistemic model — what observers believe, how they trace causation, what episodes they hold
  { section: 'Observer reasoning', icon: 'brain', tabbed: true, items: [
    { view: 'episodes', icon: 'film', label: 'Observer episodes', count: 'c-episodes' },
    { view: 'sentience', icon: 'brain', label: 'Belief states' },
    { view: 'attributions', icon: 'waypoints', label: 'Causal attributions', count: 'c-attributions' },
  ] },
  { section: 'Governance', icon: 'shield-check', tabbed: true, items: [
    { view: 'audit', icon: 'shield-check', label: 'Audit log' },
    { view: 'compliance', icon: 'file-check-2', label: 'Compliance' },
  ] },
  { section: 'Anant Trajectory', icon: 'trending-up', tabbed: true, items: [
    { view: 'liquid-whatif', icon: 'trending-up', label: 'What-If forecast' },
    { view: 'liquid-train', icon: 'cpu', label: 'Model training' },
    { view: 'liquid-score', icon: 'flask-conical', label: 'Score labs' },
    { view: 'counterfactual', icon: 'git-branch', label: 'Counterfactual studio' },
    { view: 'nudge-ledger', icon: 'bell-ring', label: 'Nudge ledger' },
  ] },
  { section: 'System', icon: 'settings', tabbed: true, items: [
    { view: 'durable', icon: 'database', label: 'Durable storage' },
    { view: 'broker', icon: 'radio', label: 'Event broker' },
    { view: 'command', icon: 'monitor-play', label: 'Command center' },
    { view: 'enterprise', icon: 'shield-check', label: 'Enterprise' },
    { view: 'fhir', icon: 'activity', label: 'FHIR entities' },
    { view: 'users', icon: 'user-cog', label: 'Users' },
    { view: 'settings', icon: 'settings', label: 'Settings' },
  ] },
  // Generic platform (port plan Phase A/B) — organization, topics, releases, DLQ
  // and the public context/work APIs. Admin-only surface for now.
  { section: 'Platform', icon: 'server', tabbed: true, items: [
    { view: 'platform-admin', icon: 'compass', label: 'Platform admin' },
    { view: 'platform-config', icon: 'sliders-horizontal', label: 'Configuration studio' },
    { view: 'platform-cohorts', icon: 'layers', label: 'Living cohorts', count: 'c-cohorts' },
    { view: 'platform-agents', icon: 'eye', label: 'Observer studio' },
    { view: 'platform-assurance', icon: 'shield-check', label: 'AI Assurance' },
    { view: 'platform-submissions', icon: 'send', label: 'CMS submissions' },
    { view: 'platform-releases', icon: 'git-branch', label: 'Release center' },
    { view: 'platform-dlq', icon: 'archive', label: 'Dead-letter queue' },
    { view: 'platform-context', icon: 'eye', label: 'Context API' },
    { view: 'rsi-intelligence', icon: 'network', label: 'Shared Intelligence ↗' },
    { view: 'rsi-executive', icon: 'trending-up', label: 'Executive Outcomes ↗' },
  ] },
  // Renal Swarm Intelligence — linked domain application (operational product).
  // Clinical / operational screens live in RSI; this section links through to it.
  { section: 'Renal Swarm', icon: 'network', items: [
    { view: 'rsi-app', icon: 'external-link', label: 'Open RSI app' },
  ] },
];

export const PIN_KEY = 'hh-pinned';

export const READ_ONLY_ALLOWED = /^(refresh|reload|fit|−|\+|100%|open|\u2192|.*\u2192\s*$|filter|search)/i;

export const READ_ONLY_ROLES = ['auditor'];

export const ROLE_NAV = {
  admin: null, // everything
  auditor: ['Overview', 'Catalog', 'Governance', 'System', 'Platform'],
  md: ['Overview', 'Agents', 'Catalog', 'World', 'Anant Trajectory', 'Renal Swarm'],
  nurse: ['Overview', 'Agents', 'Catalog', 'World', 'Anant Trajectory'],
  pharmacist: ['Overview', 'Catalog', 'World', 'Anant Trajectory'],
  coder: ['Overview', 'Agents', 'Catalog', 'World'],
  'facilities-tech': ['Overview', 'World', 'System'],
  safety: ['Overview', 'World', 'Governance', 'Anant Trajectory'],
};

export const SIDEBAR_KEY = 'hh-sidebar';

export const VIEW_INDEX = {};

export function allowedSections() {
  if (!S.sessionUser || !ROLE_NAV[S.sessionUser.role]) return null; // admins (and pre-login) see all
  return ROLE_NAV[S.sessionUser.role];
}

export function applyReadOnly() {
  if (!isReadOnlyRole()) return;
  if (!/^platform-/.test(S.currentView)) return;
  const scope = document.querySelector('main');
  if (!scope) return;
  if (!scope.querySelector('#ro-banner')) scope.insertAdjacentHTML('afterbegin', readOnlyBannerHTML());
  scope.querySelectorAll('button, input, select, textarea').forEach((el) => {
    if (el.closest('.page-tabs')) return;
    const label = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim();
    if (el.tagName === 'BUTTON' && READ_ONLY_ALLOWED.test(label)) return;
    el.disabled = true;
    el.setAttribute('title', 'Read-only role — this control is disabled. The server refuses writes for it too.');
  });
  hydrateIcons();
}

export let collapsedSections = [];

export function initSidebar() {
  loadSidebarState();
  renderSidebar();
  document.querySelectorAll('.dock-toggle').forEach((b) => b.addEventListener('click', toggleDock));
}

export function isReadOnlyRole() {
  return !!S.sessionUser && READ_ONLY_ROLES.includes(S.sessionUser.role);
}

export function loadSidebarState() {
  try { sidebarMode = localStorage.getItem(SIDEBAR_KEY) === 'collapsed' ? 'collapsed' : 'docked'; } catch (_) {}
  try { pinnedViews = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch (_) { pinnedViews = []; }
  try { collapsedSections = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); } catch (_) { collapsedSections = []; }
}

export function navGroupsForRole() {
  const allowed = allowedSections();
  return allowed ? NAV.filter((g) => allowed.includes(g.section)) : NAV;
}

export function navItemHTML(it, opts = {}) {
  const pinned = pinnedViews.includes(it.view);
  const active = S.currentView === it.view ? ' active' : '';
  const count = it.count ? `<span class="count" id="${it.count}">—</span>` : '';
  const pinIcon = pinned ? 'pin' : 'pin-off';
  const pin = `<span class="nav-pin" data-pin="${it.view}" title="${pinned ? 'Unpin' : 'Pin to top'}"><i data-lucide="${pinIcon}"></i></span>`;
  return `<div class="nav-item${active}${pinned ? ' pinned' : ''}" data-view="${it.view}" title="${opts.short ? esc(it.label) : ''}"><i data-lucide="${it.icon}"></i><span class="nav-label">${esc(it.label)}</span>${count}${opts.short ? '' : pin}</div>`;
}

export let pinnedViews = [];

export function readOnlyBannerHTML() {
  if (!isReadOnlyRole()) return '';
  return `<div class="state-card" id="ro-banner" style="border-color:color-mix(in srgb,var(--warn) 40%,transparent);">
    <div class="state-icon"><i data-lucide="eye"></i></div>
    <div class="state-title">Read-only role</div>
    <div class="state-sub">You can inspect this configuration in full; changes are refused by the server for the <code>${esc(S.sessionUser.role)}</code> role. Ask an administrator to make a change.</div>
  </div>`;
}

export function renderSidebar() {
  nav.classList.toggle('collapsed', sidebarMode === 'collapsed');
  const inner = document.getElementById('sidebar-inner');
  if (!inner) return;
  // Brand row carries the dock toggle at the top of the sidebar.
  let html = '<div class="brand"><div class="brand-mark"><i data-lucide="activity"></i></div><h1>AnantHealth</h1><button class="dock-toggle" id="dock-toggle" title="Toggle sidebar dock (collapse to icon rail)" aria-label="Toggle sidebar dock"></button></div>';
  const pinnedItems = pinnedViews.map((v) => VIEW_INDEX[v]).filter(Boolean).filter((it) => viewAllowed(it.view));
  if (pinnedItems.length) {
    html += `<div class="nav-section" data-section="__pinned"><div class="label" data-collapse="__pinned">Pinned <span class="nav-caret">▼</span></div><div class="nav-body">`;
    for (const it of pinnedItems) html += navItemHTML(it);
    html += '</div></div>';
  }
  for (const group of navGroupsForRole()) {
    const isCollapsed = collapsedSections.includes(group.section);
    // Tabbed sections and single-item sections don't need a collapse caret.
    const collapsible = !group.tabbed && group.items.length > 1;
    html += `<div class="nav-group"><div class="nav-section${isCollapsed ? ' collapsed-items' : ''}" data-section="${esc(group.section)}">`;
    html += collapsible
      ? `<div class="label" data-collapse="${esc(group.section)}">${esc(group.section)} <span class="nav-caret">▼</span></div>`
      : `<div class="label" data-section-go="${esc(group.section)}">${esc(group.section)}</div>`;
    html += '<div class="nav-body">';
    if (group.tabbed) {
      // Tabbed section → a single entry with its own icon; sub-pages live in the page tab strip.
      const first = group.items[0];
      const active = group.items.some((it) => it.view === S.currentView) ? ' active' : '';
      html += `<div class="nav-item tabbed-item${active}" data-view="${esc(first.view)}" data-section-tabbed="${esc(group.section)}" title="${esc(group.section)} (tabs)"><i data-lucide="${esc(group.icon || 'layout-grid')}"></i><span class="nav-label">${esc(group.section)}</span></div>`;
    } else {
      for (const it of group.items) html += navItemHTML(it);
    }
    html += '</div></div>';
    html += `<div class="nav-flyout"><div class="fly-label">${esc(group.section)}</div>`;
    if (group.tabbed) {
      const first = group.items[0];
      const active = group.items.some((it) => it.view === S.currentView) ? ' active' : '';
      html += `<div class="nav-item tabbed-item${active}" data-view="${esc(first.view)}" data-section-tabbed="${esc(group.section)}"><i data-lucide="${esc(group.icon || 'layout-grid')}"></i><span class="nav-label">${esc(group.section)}</span></div>`;
    } else {
      for (const it of group.items) html += navItemHTML(it, { short: true });
    }
    html += '</div></div>';
  }
  inner.innerHTML = html;
  updateDockIcon();
  if (window.hydrateIcons) window.hydrateIcons();
  updateSidebarCounts(); // refresh count badges after re-render
}

export function saveSidebarState() {
  try {
    localStorage.setItem(SIDEBAR_KEY, sidebarMode);
    localStorage.setItem(PIN_KEY, JSON.stringify(pinnedViews));
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedSections));
  } catch (_) { /* storage unavailable */ }
}

export let sidebarMode = 'docked';

export function toggleDock() {
  sidebarMode = sidebarMode === 'collapsed' ? 'docked' : 'collapsed';
  saveSidebarState();
  renderSidebar();
}

export function updateDockIcon() {
  const icon = sidebarMode === 'collapsed' ? 'panel-left-open' : 'panel-left-close';
  document.querySelectorAll('.dock-toggle').forEach((b) => { b.innerHTML = `<i data-lucide="${icon}"></i>`; });
  if (window.hydrateIcons) window.hydrateIcons();
}
