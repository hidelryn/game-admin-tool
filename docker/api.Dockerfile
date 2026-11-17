# syntax=docker/dockerfile:1
# argon2 는 glibc(linux-x64/arm64)용 사전 빌드만 제공 → Alpine(musl) 대신 Debian slim 사용
# npm workspaces 는 lockfile 검증을 위해 모든 워크스페이스의 package.json 이 필요하다.

# ---------- build: 전체 의존성 설치 + 번들 ----------
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci -w @game-admin/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build -w @game-admin/api

# ---------- prod-deps: 런타임 의존성만 (@game-admin/* 는 번들에 포함됨) ----------
FROM node:22-slim AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci -w @game-admin/api --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
# 업로드 저장 폴더 — 운영에서는 볼륨을 붙인다 (이미지의 소유자가 볼륨에 복사됨)
RUN echo '{"type":"module"}' > package.json \
  && mkdir -p storage/uploads && chown -R node:node storage
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/server.js"]
