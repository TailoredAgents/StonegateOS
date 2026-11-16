# Built from a clean checkout of the per-service revision in source-manifest.json.
ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG SERVICE
ARG SOURCE_REVISION
ENV HUSKY=0 NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm --filter api test -- --runInBand --runTestsByPath src/__tests__/database-ssl.test.ts
RUN if [ "$SERVICE" = outbox ]; then node --test scripts/migration/worker-drain.test.mjs; fi
RUN if [ "$SERVICE" = discord ]; then node --test scripts/migration/discord-drain.test.mjs && node scripts/migration/discord-drain-integration.mjs; fi
RUN --mount=type=secret,id=site_build_env case "$SERVICE" in \
      site) node infra/cloudflare/build-site.mjs ;; \
      api) pnpm --filter api build ;; \
      outbox|discord) true ;; \
      *) exit 1 ;; \
    esac
RUN printf '%s' "$SOURCE_REVISION" > /app/infra/cloudflare/source-revision

FROM cloudflare/cloudflared:2026.11.0@sha256:bf723075c9a1a35e785bdcac0e8420f504e8074cc65784ed03300b8219aafadc AS tunnel-client

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DOTENV_CONFIG_PATH=/dev/null
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --from=tunnel-client /usr/local/bin/cloudflared /usr/local/bin/cloudflared
USER node
EXPOSE 8080
# Default is a diagnostic server with no database or provider access.
# Production commands are selected only by a separately verified deployment.
CMD ["node", "infra/cloudflare/native-probe.mjs"]
