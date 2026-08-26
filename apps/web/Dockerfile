# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS dev
COPY . .
CMD ["pnpm", "--filter", "@acct/web", "dev"]

FROM deps AS build
COPY . .
RUN pnpm --filter @acct/shared build && pnpm --filter @acct/web build

FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
CMD ["pnpm", "--filter", "@acct/web", "start"]
