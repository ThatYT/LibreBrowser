FROM node:22.23.1-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY upstream/ ./
RUN pnpm install --frozen-lockfile && pnpm run check:rrweb && pnpm run build && pnpm run typecheck \
    && pnpm --filter @mirror/gateway deploy --prod /opt/gateway

FROM node:22.23.1-bookworm-slim
ENV NODE_ENV=production VIEWER_DIST_ROOT=/app/viewer HOME=/home/node \
    CHROME_PATH=/usr/bin/chromium CHROME_HEADFUL=0 CHROME_USER_DATA_DIR=/profile/chromium \
    GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-sandbox dumb-init ca-certificates fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /profile /runtime
WORKDIR /app
COPY --from=build --chown=node:node /opt/gateway/ /app/
COPY --from=build --chown=node:node /src/packages/viewer/dist/ /app/viewer/
USER node
ENTRYPOINT ["/usr/bin/dumb-init", "--single-child", "--"]
CMD ["node", "dist/main.mjs"]
