# syntax=docker/dockerfile:1
# MCP 서버 — DB·Redis 접속 정보 없이 API 만 호출한다 (architecture.md 1.1)
# npm workspaces 는 lockfile 검증을 위해 모든 워크스페이스의 package.json 이 필요하다.

# ---------- build ----------
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci -w @game-admin/mcp --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/mcp ./apps/mcp
RUN npm run build -w @game-admin/mcp

# ---------- prod-deps ----------
FROM node:22-slim AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci -w @game-admin/mcp --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/mcp/dist ./dist
RUN echo '{"type":"module"}' > package.json
USER node
EXPOSE 4100
CMD ["node", "--enable-source-maps", "dist/http.js"]
