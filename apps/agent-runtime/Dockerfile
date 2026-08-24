FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/agent-runtime/package.json apps/agent-runtime/package.json
COPY packages/agent-runtime-protocol/package.json packages/agent-runtime-protocol/package.json
COPY packages/runtime-protocol/package.json packages/runtime-protocol/package.json
RUN pnpm install --frozen-lockfile
COPY apps/agent-runtime apps/agent-runtime
COPY packages/agent-runtime-protocol packages/agent-runtime-protocol
COPY packages/runtime-protocol packages/runtime-protocol
RUN pnpm --filter @devproof/runtime-protocol build \
  && pnpm --filter @devproof/agent-runtime-protocol build \
  && pnpm --filter @devproof/agent-runtime build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY --from=build /app ./
CMD ["node", "apps/agent-runtime/dist/main.js"]
