import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
