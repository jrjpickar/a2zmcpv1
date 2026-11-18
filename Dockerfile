# A2Z MCP server. Target: linux/amd64 (Google Cloud e2-micro). Built on the VM with docker compose build.
# The node base image is multi-arch and no step is arch specific, so linux/arm64 also works.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
# Heap cap below the 512 MB container limit so Node collects garbage before the kernel OOM killer acts.
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data A2Z_STORE_DIR=/data/operations NODE_OPTIONS=--max-old-space-size=320
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY netlify ./netlify
COPY public ./public
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
