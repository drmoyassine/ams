# One image definition, two targets: `app` (Hono API + built SPA) and `worker`.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim AS base
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
USER node

FROM base AS app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

FROM base AS worker
CMD ["node", "apps/worker/dist/main.js"]
