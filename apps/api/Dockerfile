FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/agent-runtime-protocol/package.json packages/agent-runtime-protocol/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/runtime-protocol/package.json packages/runtime-protocol/package.json
COPY packages/test-domain/package.json packages/test-domain/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/agent-runtime-protocol packages/agent-runtime-protocol
COPY packages/contracts packages/contracts
COPY packages/runtime-protocol packages/runtime-protocol
COPY packages/test-domain packages/test-domain
RUN pnpm prisma:generate && pnpm build:packages && pnpm --filter @devproof/api build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY --from=build /app ./
EXPOSE 4433
CMD ["node", "apps/api/dist/main.js"]
