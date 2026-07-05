# syntax=docker/dockerfile:1

FROM oven/bun:1.2 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.2 AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLANE_CLI_HOME=/data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && mkdir -p /data \
    && chown -R bun:bun /app /data

COPY --from=build --chown=bun:bun /app/dist ./dist

USER bun
EXPOSE 3000

CMD ["bun", "dist/mcp/index.js"]
