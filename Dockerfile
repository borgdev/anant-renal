# syntax=docker/dockerfile:1
#
# AnantHealth — production image.
#
# The runtime reads a few things relative to the working directory, so the
# final image keeps the exact layout the server expects at `/app`:
#   - dist/            compiled TypeScript (src + packs)
#   - admin-ui/        the operator console (served at /admin/ui/)
#   - packs/*/agents/  authored agent specs (YAML) + pack manifests
#   - src/liquid/wasm/ the prebuilt liquid engine WASM bundle
#   - .harness/        writable runtime state (knowledge, measures, SQLite store)
#                      → mount a volume here in compose

# ---------- Stage 1: build ----------
FROM node:22-alpine AS builder
WORKDIR /app

# Dependencies first (layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Source + pack TS (compiled into dist) + agent YAML (kept verbatim).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY packs ./packs

# Compile TS → dist (src + packs only).
RUN npm run build

# The liquid WASM loader resolves ./wasm/* relative to the compiled module, so
# copy the wasm-pack output into dist/src/liquid/wasm.
COPY src/liquid/wasm dist/src/liquid/wasm/

# ---------- Stage 1b: exec-app build (Vite React executive console) ----------
FROM node:22-alpine AS exec-builder
WORKDIR /app/exec-app
COPY exec-app/package.json exec-app/package-lock.json ./
RUN npm ci
# Source (Vite build) + reference data JSONs + styles.
COPY exec-app/ ./
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HH_HTTP_PORT=8080 \
    HH_HTTP_HOST=0.0.0.0
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled app + the data assets the server reads from the working directory.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packs ./packs
COPY --from=builder /app/src/liquid/wasm ./src/liquid/wasm
COPY admin-ui ./admin-ui
# Executive console (served at /exec/ by admin-routes).
COPY --from=exec-builder /app/exec-app/dist ./exec-app/dist
# Catalog seed fixtures the swarm workspace reads to seed the durable catalogs.
COPY exec-app/src/data ./exec-app/src/data
# Real public CMS QIP / Dialysis Facility Compare datasets (readiness + facility
# records for the exec CMS panel — cms-data/manifest.json, modified 2026-06-16).
COPY cms-data ./cms-data

# Writable runtime state (knowledge store, measures, SQLite SqlStore, realm
# snapshots). /app/packs is writable so the authoring service can create drafts.
# Only these two dirs need writes — avoid chowning the whole tree (node_modules).
RUN mkdir -p .harness && chown -R node:node .harness packs

USER node
EXPOSE 8080

# /health reports db + redis + broker health (all-or-nothing).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{ if(!r.ok) process.exit(1); return r.json(); }).then(j=>process.exit(j && j.ok ? 0 : 1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server/prod.js"]
