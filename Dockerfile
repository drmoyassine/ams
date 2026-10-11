# One image definition, four targets: `app` (Hono API + built SPA) and the three background services `worker`, `parser`
# and `agent` (DEC-024). The three run the same entry point (apps/worker/dist/main.js); the role comes from the
# environment (WORKER_QUEUES and WORKER_NAME, set per service in compose.yaml), so there is one code path and the targets
# differ only by name. The base is shared, so liteparse is installed in every target; only `parser` (and `parser` alone)
# parses documents at run time, and only `parser` gets LibreOffice and ImageMagick (liteparse converts every non-PDF
# format with them, DEC-011), so the app, worker and agent images stay slim.
# Per service: `agent` needs the AI settings (AI_*, *_API_KEY) and outbound internet;
# `parser` needs S3 and DATABASE_URL; `worker` needs DATABASE_URL and S3; none of them needs the Garage admin variables.
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
# start-period: the app migrates the database and prepares Garage (waiting for it if needed) before it listens, and the
# background services wait for it to be healthy.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=180s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

FROM base AS worker
CMD ["node", "apps/worker/dist/main.js"]

FROM base AS parser
# liteparse reads Word, Excel, PowerPoint, OpenDocument, RTF and CSV by converting them to PDF with LibreOffice
# (`soffice` on PATH), and some image formats with ImageMagick (`convert`). Only the three LibreOffice components
# needed are installed (writer: DOC/DOCX/ODT/RTF, calc: XLS/XLSX/ODS/CSV, impress: PPT/PPTX/ODP), without recommended
# packages (no Java, no GUI). Fonts: Noto covers Arabic and Latin, Liberation matches the metrics of Arial/Times New
# Roman so converted pages break as they did in Word. HOME is writable for the non-root user (LibreOffice profile).
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      imagemagick fonts-noto-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
ENV HOME=/home/node
USER node
CMD ["node", "apps/worker/dist/main.js"]

FROM base AS agent
CMD ["node", "apps/worker/dist/main.js"]
