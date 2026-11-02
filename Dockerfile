# syntax=docker/dockerfile:1
#
# brain-mcp — the MCP server for the Brain memory database.
#
#     docker build -t brain-mcp:latest .
#
# The image holds no credential. Over HTTP every request carries its own
# `Authorization: Bearer <brain_…>`, which is forwarded to the backend
# verbatim, so one container serves every user at their own identity. The only
# thing it must be told is where the backend is:
#
#     docker run -p 3333:3333 \
#       -e BRAIN_MCP_BACKEND_URL=https://api.arc-labs.ai \
#       ghcr.io/arc-labs-ai/brain-mcp:latest
#
# There is deliberately no BRAIN_MCP_API_KEY in the HTTP path and no default
# for it here: a server-held key would let a request that forgot its header
# succeed as whoever that key belongs to.

# ---- deps: production dependency tree, resolved once -----------------------
# Separate from `build` so the runtime stage can take node_modules without the
# TypeScript toolchain, biome's platform binary, or vitest coming with it.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# --omit=dev: only what `dist/` actually requires at runtime.
# `npm ci` builds strictly from the committed lockfile, so the image is
# reproducible and a drifting transitive dep can't silently change what ships.
RUN npm ci --omit=dev --ignore-scripts

# ---- build: compile TypeScript to dist/ ------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# curl is not optional. Our ECS task definition hardcodes its container health
# check as `curl -f http://localhost:<port><path>` (infra modules/ecs_service),
# so an image without curl fails every probe and the task is killed and
# replaced in a loop that looks exactly like the app being broken. The
# HEALTHCHECK below uses the same tool for the same reason: if curl went
# missing, the image's own health check would fail here rather than in a
# deploy.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist

# Not vestigial: `"type": "module"` lives here, and without it node reads
# dist/*.js as CommonJS and the first `import` fails at startup.
COPY package.json ./

# The node image ships a non-root `node` user (uid 1000); nothing here needs
# to write to the filesystem, so the process runs as it.
USER node

# Matches BRAIN_MCP_PORT's default. The server binds 0.0.0.0 by default, which
# is what makes it reachable from outside the container.
EXPOSE 3333

# /healthz is unauthenticated by design — a load balancer has no bearer to
# send — so this probe needs no credential, and a 200 here means the process
# is serving, not that any particular backend is reachable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3333/healthz || exit 1

# Exec form, no shell: node is PID 1 and receives SIGTERM directly, so ECS
# stopping a task is a clean exit rather than a 30-second kill.
ENTRYPOINT ["node", "dist/index.js"]
