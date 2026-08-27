import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The harness Fastify server serves exec-app/dist at /exec/ — so assets are
// emitted with base "/exec/".
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/exec/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5180 },
});
