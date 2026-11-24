FROM oven/bun:1-alpine AS deps
WORKDIR /app
# Bun's default of many parallel downloads stalls behind Docker's bridge network (minutes for
# the dev install, which looks stuck); fewer at a time finishes in seconds.
ARG BUN_NETWORK_CONCURRENCY=16
COPY package.json bun.lock ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
COPY block-ui/package.json block-ui/
RUN bun install --frozen-lockfile --production --network-concurrency=$BUN_NETWORK_CONCURRENCY

FROM oven/bun:1-alpine AS web
WORKDIR /app
ARG BUN_NETWORK_CONCURRENCY=16
COPY package.json bun.lock ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
# The UI library is a git submodule and a workspace package.
COPY block-ui block-ui
RUN bun install --frozen-lockfile --network-concurrency=$BUN_NETWORK_CONCURRENCY
COPY tsconfig.base.json ./
COPY shared shared
COPY web web
RUN bun run --cwd web build

# Scalar's package drags in hundreds of MB of dependencies, but the API reference page only
# needs its browser bundle, so that one file is all the final image takes from it.
FROM web AS scalar
RUN cp "$(cd server && bun -e 'console.log(new URL("./browser/standalone.js", import.meta.resolve("@scalar/api-reference")).pathname)')" /standalone.js

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 SCALAR_BUNDLE=/app/docs/standalone.js
COPY package.json ./
COPY server server
COPY shared shared
COPY scripts scripts
# Bun links workspace dependencies through each package's own node_modules.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=deps /app/shared/node_modules shared/node_modules
COPY --from=web /app/web/dist web/dist
COPY --from=scalar /standalone.js docs/standalone.js
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/me`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "server/src/index.ts"]
