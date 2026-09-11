import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paletteBootstrap } from "./vite/palette-bootstrap";

// The harness Fastify server serves exec-app/dist at /exec/ — so assets are
// emitted with base "/exec/".
export default defineConfig({
  plugins: [react(), tailwindcss(), paletteBootstrap()],
  base: "/exec/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5180 },
});
