#!/usr/bin/env bash
# 운영 배포 (서버에서 실행) — docs/deployment.md 5장
#   사용: IMAGE_PREFIX=ghcr.io/<owner>/<repo> ./deploy.sh <커밋 태그>
# 순서: 이미지 받기 → DB·Redis 확인 → 마이그레이션 → 앱 교체 → 상태 확인 → 실패하면 이전 태그로 되돌림
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:?배포할 태그를 지정하세요}"
: "${IMAGE_PREFIX:?IMAGE_PREFIX 를 지정하세요 (예: ghcr.io/owner/repo)}"
[ -f .env ] || { echo ".env 가 없습니다 (docs/deployment.md 3장)"; exit 1; }
DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
[ -n "$DOMAIN" ] || { echo ".env 에 DOMAIN 이 없습니다"; exit 1; }

PREV="$(cat .deployed-tag 2>/dev/null || true)"
compose() { IMAGE_PREFIX="$IMAGE_PREFIX" IMAGE_TAG="$1" docker compose -f docker-compose.prod.yml "${@:2}"; }
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

log "배포 $PREV → $TAG"
compose "$TAG" pull api worker web mcp
compose "$TAG" up -d --wait mysql redis

# 마이그레이션은 앞으로만 진행 (되돌리기는 이미지만). 실패하면 앱을 바꾸지 않고 중단
log "마이그레이션"
compose "$TAG" run --rm --no-deps api node dist/migrate.js

log "앱 교체"
compose "$TAG" up -d --remove-orphans

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "https://$DOMAIN/api/v1/health/ready" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

if healthy; then
  echo "$TAG" > .deployed-tag
  log "완료: https://$DOMAIN (태그 $TAG)"
  docker image prune -f >/dev/null || true
else
  log "상태 확인 실패"
  compose "$TAG" logs --tail=50 api || true
  if [ -n "$PREV" ]; then
    log "이전 태그 $PREV 로 되돌림 (DB 스키마는 그대로 — 새 마이그레이션이 이전 코드와 호환되는지 확인 필요)"
    compose "$PREV" up -d --remove-orphans
  fi
  exit 1
fi
