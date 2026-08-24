FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/agent-runtime-protocol/package.json packages/agent-runtime-protocol/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/runtime-protocol/package.json packages/runtime-protocol/package.json
COPY packages/test-domain/package.json packages/test-domain/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages/agent-runtime-protocol packages/agent-runtime-protocol
COPY packages/contracts packages/contracts
COPY packages/runtime-protocol packages/runtime-protocol
COPY packages/test-domain packages/test-domain
COPY packages/ui packages/ui
ARG NEXT_PUBLIC_RUNTIME_API_URL
ENV NEXT_PUBLIC_RUNTIME_API_URL=$NEXT_PUBLIC_RUNTIME_API_URL
RUN pnpm build:packages && pnpm --filter @devproof/web build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3344
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3344
CMD ["node", "apps/web/server.js"]
