# Engine image. Built from the repository root so the workspace lockfile applies:
#   docker build -f apps/engine/Dockerfile -t wick-engine .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/engine/package.json apps/engine/
COPY apps/desk/package.json apps/desk/
RUN npm ci --ignore-scripts --omit=dev --workspace @wick/engine --workspace @wick/core

FROM node:22-alpine
ENV NODE_ENV=production
RUN addgroup -S wick && adduser -S wick -G wick
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY packages/core ./packages/core
COPY apps/engine ./apps/engine
USER wick
WORKDIR /repo/apps/engine
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:9464/healthz || exit 1
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/main.ts"]
