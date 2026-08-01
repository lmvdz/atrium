# syntax=docker/dockerfile:1
# Atrium server image — WebSocket realtime + pg-boss workers.
# Built from the repo root: `docker build -f apps/server/Dockerfile .`

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── dependencies (cached on manifests alone) ────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
RUN pnpm --filter @atrium/core --filter @atrium/db --filter @atrium/server build

# ── runtime ─────────────────────────────────────────────────────────────────
# The whole workspace ships as-is: `pnpm deploy` cannot be trusted across pnpm
# majors, and the image is small enough that trimming it is not worth a
# fragile build. Revisit if image size ever becomes a real cost.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/server
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
