import type { Plugin } from "vite";

/**
 * Palette bootstrap injector.
 *
 * `data-palette` on `<html>` selects which token set applies (see
 * `src/globals.css`). Applying it from the module graph is too late: the
 * stylesheet is already painting, so a cold load would flash the other palette.
 * Injecting it into `<head>` ahead of the bundle fixes that, and doing it here
 * rather than in `index.html` keeps the palette's bootstrap next to the palette
 * code it has to agree with.
 *
 * The fallback must match `DEFAULT_PALETTE` in `src/lib/palette.ts`.
 */
const FALLBACK = "anantstate";
const KNOWN = ["slate", "anantstate"];

export function paletteBootstrap(): Plugin {
  const script = [
    "<script>",
    "(function(){try{",
    "var p=localStorage.getItem('hh-palette');",
    `document.documentElement.dataset.palette=${JSON.stringify(KNOWN)}.indexOf(p)>=0?p:${JSON.stringify(FALLBACK)};`,
    "}catch(e){}})();",
    "</script>",
  ].join("");

  return {
    name: "anant-palette-bootstrap",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("</head>", `${script}</head>`),
    },
  };
}
