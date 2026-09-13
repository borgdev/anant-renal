/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

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
