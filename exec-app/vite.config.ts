import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { themeBootstrap } from "./vite/theme-bootstrap";

// The harness Fastify server serves exec-app/dist at /exec/ — so assets are
// emitted with base "/exec/".
export default defineConfig({
  plugins: [react(), tailwindcss(), themeBootstrap()],
  base: "/exec/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5180 },
});
