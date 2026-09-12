/*
 * Router — the view registry, navigation, and the render dispatch.
 *
 * WHY A REGISTRY
 * --------------
 * `render()` dispatched 48 views with a 48-branch if/else, so whichever module held
 * it had to import every view module — while every view module needs `goTo` back.
 * That cycle is what kept `render`, `goTo` and 26 others welded into app.js: no
 * order of files can satisfy both directions with plain imports.
 *
 * The registry breaks it in one direction only. This module owns the map and never
 * imports a view; the entry point (app.js) registers the view functions it already
 * imports. Nothing here imports back, so there is no cycle to reason about.
 */
import { S } from '../state.js';
import { applyReadOnly, renderSidebar } from './nav.js';
import { updateSidebarCounts } from './scope.js';
import { renderPageTabs } from './tabs.js';
import { hydrateIcons } from './theme.js';
import { refreshSyntheticBadge, viewAllowed } from '../views/editor.js';

/** view id -> render function. Populated by the entry point via registerView. */
export const VIEWS = new Map();

/**
 * Register a view's render function. Duplicate ids throw rather than silently
 * overwrite: a second registration means two modules claim one nav entry, which is
 * exactly the kind of drift this refactor exists to make impossible.
 */
export function registerView(id, fn) {
  if (typeof fn !== 'function') throw new Error(`registerView('${id}'): not a function`);
  if (VIEWS.has(id)) throw new Error(`duplicate view registration: ${id}`);
  VIEWS.set(id, fn);
}

/** Navigate: guard the view, remember it, and re-render the shell around it. */
export function goTo(view) {
  if (!viewAllowed(view)) view = 'summary';
  S.currentView = view;
  renderSidebar();
  render();
  refreshSyntheticBadge();
}

/**
 * Render the current view. The tab strip and sidebar counts come first so the shell
 * is correct even if the view's own render throws.
 *
 * An unknown id renders nothing and leaves the previous content in place — that is
 * the pre-registry behaviour, preserved deliberately. (The page walk fails a view
 * that does not activate, so this cannot go unnoticed.)
 */
export async function render() {
  renderPageTabs();
  await updateSidebarCounts();
  const view = S.currentView;
  const handler = VIEWS.get(view);
  if (handler) await handler();
  hydrateIcons();
  // A read-only role keeps the page and loses the writers (server-enforced too).
  applyReadOnly();
}
