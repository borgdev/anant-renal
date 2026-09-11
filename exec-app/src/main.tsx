import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Theme bootstrap (sets data-theme) must be evaluated before the stylesheets are
// applied so the first frame uses the chosen theme, hence the import order.
import "./lib/theme";
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
