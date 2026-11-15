# Built from a clean checkout of the per-service revision in source-manifest.json.
FROM node:24.21.0-bookworm-slim AS build
ARG SERVICE
ARG SOURCE_REVISION
ENV HUSKY=0 NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
RUN --mount=type=secret,id=site_build_env case "$SERVICE" in \
      site) node infra/cloudflare/build-site.mjs ;; \
      api) pnpm --filter api build ;; \
      outbox|discord) true ;; \
      *) exit 1 ;; \
    esac
RUN printf '%s' "$SOURCE_REVISION" > /app/infra/cloudflare/source-revision

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DOTENV_CONFIG_PATH=/dev/null
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
# Default is a diagnostic server with no database or provider access.
# Production commands are selected only by a separately verified deployment.
CMD ["node", "infra/cloudflare/native-probe.mjs"]
