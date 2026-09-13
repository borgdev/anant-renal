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

import type { Plugin } from "vite";

/**
 * Theme bootstrap injector.
 *
 * `data-theme` on `<html>` selects which token set applies (see
 * `src/globals.css`). Applying it from the module graph is too late: the
 * stylesheet is already painting, so a cold load would flash the other theme.
 * Injecting it into `<head>` ahead of the bundle fixes that, and doing it here
 * rather than in `index.html` keeps the bootstrap next to the code it has to
 * agree with.
 *
 * The fallback must match `DEFAULT_THEME` in `src/lib/theme.ts`.
 */
const FALLBACK = "dark";

export function themeBootstrap(): Plugin {
  const script = [
    "<script>",
    "(function(){try{",
    "var t=localStorage.getItem('hh-theme');",
    `document.documentElement.dataset.theme=t==='light'?'light':${JSON.stringify(FALLBACK)};`,
    "if(t==='light')document.documentElement.classList.remove('dark');else document.documentElement.classList.add('dark');",
    "}catch(e){}})();",
    "</script>",
  ].join("");

  return {
    name: "anant-theme-bootstrap",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("</head>", `${script}</head>`),
    },
  };
}
