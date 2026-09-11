// ---------------------------------------------------------------------------
// Theme — `data-theme` on <html> selects the token set in force.
//
//   dark   the engine room: Deep Obsidian + Electric Teal (default)
//   light  the enterprise / executive reading surface: Clean Frost + Deep Blue
//
// Both sets declare the SAME variable names in globals.css, so switching is an
// attribute write — no reload, no second stylesheet, and no rule anywhere
// branches on the theme. Applied before React mounts so the first frame is
// already correct (see vite/theme-bootstrap.ts for the pre-paint path).
// ---------------------------------------------------------------------------
export type ThemeName = "dark" | "light";

export const DEFAULT_THEME: ThemeName = "dark";

export const THEME_LABEL: Record<ThemeName, string> = {
  dark: "Dark",
  light: "Light",
};

const STORAGE_KEY = "hh-theme";

export function readTheme(): ThemeName {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : DEFAULT_THEME;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_THEME;
}

export function applyTheme(name: ThemeName): void {
  const root = document.documentElement;
  root.dataset.theme = name;
  // `color-scheme` follows via the CSS token block, so native controls,
  // scrollbars and form widgets flip with it.
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* non-fatal: the attribute is already applied for this session */
  }
}

export function otherTheme(name: ThemeName): ThemeName {
  return name === "dark" ? "light" : "dark";
}

applyTheme(readTheme());
