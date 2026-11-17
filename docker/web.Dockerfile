# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci -w @game-admin/web --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build -w @game-admin/web

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
