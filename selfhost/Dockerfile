# Express Tech Design Center — the LV Planner, live projects (site app), client view, logins, sharing, notifications.
# Built from the top of the repository (the planner and the live-project server live there):
#   cd selfhost && docker compose up -d --build
FROM node:22-alpine

RUN apk add --no-cache tzdata
ENV NODE_ENV=production \
    TZ=Asia/Kuwait \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY selfhost/package.json ./
COPY selfhost/src ./src
COPY selfhost/scripts ./scripts
COPY selfhost/public ./public
# the live-project server (the same file that ran on Cloudflare)
COPY server/worker.js ./worker/worker.mjs
# the planner and the site app (the same files GitHub Pages serves)
COPY index.html site.html sw.js version.json manifest.webmanifest site.webmanifest ./public/app/
COPY *.png ./public/app/
# the browser libraries (pdf.js, jsPDF, pdf-lib, the barcode reader) are fetched once here and served by this server,
# so browsers load nothing from outside sites (see vendor/libs.json)
COPY selfhost/vendor ./vendor
RUN node scripts/vendor-libs.js /app/public/app-vendor

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
