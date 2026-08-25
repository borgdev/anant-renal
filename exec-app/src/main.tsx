import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import AuthGate from "./auth-gate";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
