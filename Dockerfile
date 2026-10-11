# One image definition, four targets: `app` (Hono API + built SPA) and the three background services `worker`, `parser`
# and `agent` (DEC-024). The three run the same entry point (apps/worker/dist/main.js); the role comes from the
# environment (WORKER_QUEUES and WORKER_NAME, set per service in compose.yaml), so there is one code path and the targets
# differ only by name. The base is shared, so the parsers are installed in every target (pure JavaScript plus the prebuilt
# sharp and @napi-rs/canvas binaries, which need no apt packages on node:22-slim); only `parser` (and `parser` alone)
# parses documents at run time, and only `parser` gets LibreOffice, for the temporary fallback formats (DEC-011), so the
# app, worker and agent images stay slim.
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
# PDF, Word, Excel, CSV and images are read by the owned @drmoyassine/liteparse in plain Node (pdfjs-dist, mammoth,
# SheetJS; scanned pages are rendered with sharp and @napi-rs/canvas, whose prebuilt Linux binaries come with the pnpm
# install). LibreOffice is here ONLY for the temporary fallback reader (packages/core/src/framework/parse-document-fallback.ts):
# PowerPoint, OpenDocument, RTF and legacy DOC/XLS, which the owned library does not read yet. Delete the apt block below
# when it does (docs/liteparse-appendix-d-status.md). Only the three components needed are installed (writer: DOC/ODT/RTF,
# calc: XLS/ODS, impress: PPT/PPTX/ODP), without recommended packages (no Java, no GUI). Fonts: Noto covers Arabic and Latin,
# Liberation matches the metrics of Arial/Times New Roman; they also let pdfjs draw pages whose fonts are not embedded
# when a page is rendered for the vision model. HOME is writable for the non-root user (LibreOffice profile).
# Optional local OCR (PARSER_LOCAL_OCR=rapidocr) additionally needs onnxruntime-node and the RapidOCR model files baked
# into the image (RAPIDOCR_MODEL_PATH); it is off and not installed, see the status document.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-noto-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
ENV HOME=/home/node
USER node
CMD ["node", "apps/worker/dist/main.js"]

FROM base AS agent
CMD ["node", "apps/worker/dist/main.js"]
