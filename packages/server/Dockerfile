# syntax=docker/dockerfile:1
#
# The primary self-host artifact: build the single-file bundle, then ship it on a
# minimal Node 24 image (node:sqlite is flag-free on 24). The build context is
# the repo root — build with:
#
#   docker build -f packages/server/Dockerfile -t dwk-server .
#
# To run your own composition, point `bundle` at your entry and rebuild. Identity
# is HTTPS-rooted: set DWK_BASE_URL to your public https origin and terminate TLS
# at a reverse proxy (Caddy/nginx/Traefik) in front of this container.
# @see spec/self-hosting.md §3, §10, §12

FROM node:24-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
COPY . .
# Build all workspace packages (the bundle resolves @dwk/* deps from their dist),
# then bundle @dwk/server into the single-file image payload.
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @dwk/server bundle

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DWK_DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=builder /repo/packages/server/dist-bundle/dwk-serve.mjs ./dwk-serve.mjs
# The data dir holds keys and all pod data — mount a volume and keep it private.
RUN useradd --uid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin dwk \
 && mkdir -p /data \
 && chown -R dwk:dwk /app /data \
 && chmod 700 /data
USER dwk
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "dwk-serve.mjs"]
