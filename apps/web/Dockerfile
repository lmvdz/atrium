# syntax=docker/dockerfile:1
# Atrium web image — Next.js standalone output.
# Built from the repo root: `docker build -f apps/web/Dockerfile .`

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
# See the note in apps/server/Dockerfile: the build below filters over every
# package, so every package's manifest has to be installed here.
COPY packages/ingest/package.json packages/ingest/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY design design
COPY packages packages
COPY apps/web apps/web
# The web app signs people in and reads workspaces, so it needs @atrium/db and
# @atrium/auth built, not just the core.
RUN pnpm --filter "./packages/*" build && pnpm --filter @atrium/web build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
