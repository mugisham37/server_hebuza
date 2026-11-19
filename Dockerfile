# syntax=docker/dockerfile:1.7
# One image, two processes: api (default CMD) and worker (`node dist/worker.js`); `node dist/migrate.js` applies
# migrations and exits (also built alone as `--target migrate`). Build from this folder: docker build -t hebuza-api server/
# Debian slim (not distroless) so Render's preDeployCommand / one-off shell commands (admin:create) can run.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && mkdir -p /out/src/db && cp -r dist openapi.json package.json pnpm-lock.yaml /out/ && cp -r src/db/migrations /out/src/db/ \
 && cd /out && pnpm install --prod --frozen-lockfile --ignore-scripts \
 && find /out/node_modules -type f \( -name "*.map" -o -name "*.md" -o -name "*.d.ts" \) -delete

FROM node:22-bookworm-slim AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
CMD ["node", "dist/migrate.js"]

FROM migrate AS runtime
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
