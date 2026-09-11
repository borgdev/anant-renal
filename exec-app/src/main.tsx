import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Palette bootstrap (sets data-palette) must be evaluated before the stylesheets
// are applied so the first frame uses the chosen palette, hence the import order.
import "./lib/palette";
// Tailwind v4 first (shared Anant design tokens + preflight), then the exec
// console's component styles (globals overrides preflight where needed).
import "./tailwind.css";
import "./globals.css";
import AuthGate from "./auth-gate";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
