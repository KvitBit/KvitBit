# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.4.2

# -----------------------------------------------------------------------------
# Stage 1: Full workspace dependencies + optional static builds (web & mobile)
# -----------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS builder

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json tsconfig.effect.json turbo.json ./
COPY assets ./assets
COPY packages ./packages
COPY infra/alchemy/package.json ./infra/alchemy/package.json
COPY apps ./apps

RUN bun install --frozen-lockfile

RUN mkdir -p /app/public/web /app/public/app \
  && if [ -f apps/web/package.json ]; then \
       bun run --filter @kvitbit/web build && cp -R apps/web/dist/. /app/public/web/; \
     fi \
  && if [ -f apps/mobile/package.json ]; then \
       bun run --filter @kvitbit/mobile build && cp -R apps/mobile/dist/. /app/public/app/; \
     fi

# -----------------------------------------------------------------------------
# Stage 2: Clean production-only dependencies (fresh stage so devDeps are absent)
# -----------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS prod-deps

WORKDIR /app

COPY package.json bun.lock ./
COPY packages ./packages
COPY infra/alchemy/package.json ./infra/alchemy/package.json
COPY apps ./apps

RUN bun install --frozen-lockfile --production

# -----------------------------------------------------------------------------
# Stage 3: Hardened Debian runtime with Bun, Chromium, Czech PDF fonts, and tini
# -----------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       chromium \
       fonts-dejavu-core \
       fonts-liberation \
       tini \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 kvitbit \
  && useradd --uid 10001 --gid 10001 --home-dir /var/lib/kvitbit --shell /usr/sbin/nologin kvitbit \
  && install -d -o 10001 -g 10001 -m 0750 /var/lib/kvitbit /var/lib/kvitbit/blobs /var/lib/kvitbit/mobile

WORKDIR /app

COPY --from=prod-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=prod-deps --chown=10001:10001 /app/package.json ./package.json
COPY --from=prod-deps --chown=10001:10001 /app/bun.lock ./bun.lock
COPY --from=prod-deps --chown=10001:10001 /app/packages ./packages
COPY --from=prod-deps --chown=10001:10001 /app/apps ./apps
COPY --from=builder --chown=10001:10001 /app/public ./public
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/kvitbit
COPY docker/database-target.sh /usr/local/bin/database-target.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    KVITBIT_RUNNER_MODE=single \
    KVITBIT_BLOB_DRIVER=local \
    KVITBIT_BLOB_DIR=/var/lib/kvitbit/blobs \
    KVITBIT_BLOB_BUCKET="" \
    KVITBIT_GCS_PROJECT="" \
    KVITBIT_WEB_DIR=/app/public/web \
    KVITBIT_PWA_DIR=/app/public/app \
    KVITBIT_CHROMIUM_PATH=/usr/bin/chromium \
    CHROMIUM_PATH=/usr/bin/chromium \
    KVITBIT_TRUSTED_PROXY_HOPS=0 \
    KVITBIT_SHARE_KEY_VERSION=1 \
    KVITBIT_MOBILE_STORAGE_BUCKET="" \
    KVITBIT_MOBILE_STORAGE_DIR=/var/lib/kvitbit/mobile \
    KVITBIT_ANDROID_ASSETLINKS_SHA256=""

USER 10001:10001

EXPOSE 8080 34431

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/local/bin/kvitbit", "healthcheck"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kvitbit"]
CMD ["server"]
