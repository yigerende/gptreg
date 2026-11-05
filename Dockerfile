FROM node:22-bookworm-slim AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS backend
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY bin/ ./bin/
COPY scripts/ ./scripts/
COPY docker/ ./docker/
COPY test/ ./test/
COPY index.js gpt-re.config.example.json dynamic-proxy-pools.example.json proxy-pool.example.txt ./
RUN npm test

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/yigerende/gptreg" \
      org.opencontainers.image.revision=$VCS_REF
COPY --from=backend --chown=node:node /app/ ./
COPY --from=frontend --chown=node:node /build/web/dist/ ./web/dist/
RUN mkdir -p /app/.runtime && chown node:node /app/.runtime
USER node
EXPOSE 3210
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "docker/server.js"]
