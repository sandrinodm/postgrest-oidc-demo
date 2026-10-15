# The PostgREST debugger (apps/web) as a production container.
#
#   docker build -t timeoff-web .
#   docker run --rm -p 3000:3000 -e POSTGREST_BASE_URI=https://postgrest.example.com timeoff-web
#
# Required:  POSTGREST_BASE_URI  base URI of the PostgREST API
# Optional:  APP_URL, OIDC_*, ADMIN_*, PORT
#            (see apps/web/.env.example and infra/docker/.env.example)

# --- Build ------------------------------------------------------------------
FROM node:24-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Dependencies first, so they stay cached until the lockfile changes; the pnpm
# store is a cache mount, so a lockfile change only downloads what is new.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter web...

# Only the app's sources, so edits to db/, scripts/ or docs don't rebuild it.
COPY apps/web apps/web
RUN pnpm --filter web build

# --- Run --------------------------------------------------------------------
# The build output is self-contained (its dependencies are bundled in
# .output/server), so the runtime image needs neither pnpm nor node_modules.
FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.output ./.output
COPY --chmod=755 apps/web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
