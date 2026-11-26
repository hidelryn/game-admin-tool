# REST API 명세

> 상태: **Phase 1 초안 — 검토/승인 대기** (목록 수준. 요청/응답 상세 스키마는 Phase 3에서 zod 스키마 기준 OpenAPI로 자동 생성)

## 1. 공통 규칙

| 항목 | 규칙 |
|---|---|
| Base URL | `/api/v1` |
| 인증 | `Authorization: Bearer <accessToken 또는 API 토큰>` |
| 채널 | `X-Channel: WEB` / `MCP` — API 토큰 인증 시 서버가 `MCP`로 강제 (클라이언트 값 불신) |
| 요청 ID | `X-Request-Id` (없으면 서버 생성), 응답 헤더로 반환 |
| 중복 방지 | 변경 API 중 **🔁 표시**는 `Idempotency-Key` 헤더 필수 (UUID v4) |
| 사유 | **📝 표시**는 body에 `reason` 필수 (5~200자) |
| 시각 | ISO 8601 UTC (`2026-11-06T10:00:00Z`) |
| 페이지네이션 | 목록: `?page=1&size=20` (size 최대 100). 대용량 이력: `?cursor=<opaque>&size=50` |
| 명명 | URL kebab-case, JSON camelCase |

### 1.1 응답 형식

```json
// 성공
{ "data": { ... }, "meta": { "page": 1, "size": 20, "total": 1532 } }

// 실패
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "보유 재화가 부족합니다.", "details": { "balance": 300, "requested": 500 }, "requestId": "01J..." } }
```

에러 코드 전체 목록: architecture.md 7.1

### 1.2 확인 토큰 흐름 (위험도 L2)

```
POST /users/U1001/currencies/deduct  { currencyCode, amount, reason }
→ 422 CONFIRMATION_REQUIRED
  { error: { details: { preview: { before: 1200, after: 700 }, confirmationToken: "cf_...", expiresAt } } }

POST /users/U1001/currencies/deduct  { ..., confirmationToken: "cf_..." }   (같은 Idempotency-Key)
→ 200 OK
```

L3 작업(대량 지급 100명↑·전체 우편·랭킹 초기화/복원/보상)도 같은 2단계지만 **웹에서만** 실행된다. 미리보기는 `{ action, title, facts[{label,value}], warnings[] }`(빨간 경고 화면). MCP(API 토큰)로 호출하면 토큰 없이 `403 CHANNEL_NOT_ALLOWED` + `details.preview` 를 돌려준다. (2026-11-16 4-eyes 승인 제거)

## 2. 엔드포인트 목록

범례: 권한 = 필요한 permission, 위험 = architecture.md 4.4 등급

### 2.1 인증 (auth)

| Method | Path | 설명 | 권한 | 비고 |
|---|---|---|---|---|
| POST | `/auth/login` | 로그인 | 공개 | Rate Limit: IP당 분당 10회 |
| POST | `/auth/refresh` | 토큰 재발급(회전) | 쿠키 | `X-Requested-With` 헤더 필수 |
| POST | `/auth/logout` | 로그아웃 | 인증 | |
| GET | `/auth/me` | 내 정보 + 실효 권한 목록 | 인증 | 프론트 메뉴 구성용 |
| PATCH | `/auth/me/password` | 비밀번호 변경 | 인증 | 현재 비밀번호 확인 |

### 2.2 운영자·권한 (admins)

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/admins` | 운영자 목록 | `admin:manage` |
| POST | `/admins` | 운영자 생성 (임시 비밀번호) | `admin:manage` |
| GET | `/admins/:adminId` | 운영자 상세 | `admin:manage` |
| PATCH | `/admins/:adminId` | 이름·역할·상태 변경 📝 | `admin:manage` |
| PUT | `/admins/:adminId/permission-overrides` | 개별 권한 GRANT/DENY 설정 📝 | `admin:manage` |
| POST | `/admins/:adminId/reset-password` | 비밀번호 초기화 📝 | `admin:manage` |
| GET | `/roles` | 역할 + 권한 매핑 | `admin:manage` |
| GET | `/permissions` | 권한 목록 | `admin:manage` |

### 2.3 API 토큰 (MCP용)

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/me/api-tokens` | 내 토큰 목록 (원문 미포함) | `token:manage_own` |
| POST | `/me/api-tokens` | 발급 `{ name, permissions[], expiresInDays }` — 원문 1회 반환 | `token:manage_own` |
| DELETE | `/me/api-tokens/:tokenId` | 폐기 | `token:manage_own` |
| GET | `/admins/:adminId/api-tokens` | 특정 운영자 토큰 조회 | `admin:manage` |
| DELETE | `/admins/:adminId/api-tokens/:tokenId` | 강제 폐기 📝 | `admin:manage` |

### 2.4 회원 (users)

| Method | Path | 설명 | 권한 | 위험 |
|---|---|---|---|---|
| GET | `/users` | 목록·검색 `?publicId&nickname&status&registeredFrom&registeredTo&sort` | `user:read` | L0 |
| GET | `/users/:publicId` | 상세 (재화 요약, 진행 중 정지, 최근 활동 5건) | `user:read` | L0 |
| GET | `/users/:publicId/pii` | 개인정보 원문 (열람 로그 기록) | `user:read_pii` | L0 |
| GET | `/users/:publicId/activities` | 활동 이력 `?type&from&to&cursor` | `user:read` | L0 |
| GET | `/users/:publicId/suspensions` | 정지 이력 | `user:read` | L0 |
| POST | `/users/:publicId/suspend` | 정지 `{ durationDays \| permanent, reason }` 📝 | `user:suspend` | L1 (영구: L2) |
| POST | `/users/:publicId/unsuspend` | 해제 `{ reason }` 📝 | `user:suspend` | L1 |

### 2.5 재화 (currencies)

| Method | Path | 설명 | 권한 | 위험 |
|---|---|---|---|---|
| GET | `/currencies` | 재화 마스터 (상한 포함) | `currency:read` | L0 |
| GET | `/users/:publicId/currencies` | 회원 잔액 | `currency:read` | L0 |
| GET | `/users/:publicId/currency-transactions` | 회원 재화 이력 `?currencyCode&from&to&cursor` | `currency:read` | L0 |
| POST | `/users/:publicId/currencies/grant` | 지급 `{ currencyCode, amount, reason, confirmationToken? }` 🔁📝 | `currency:grant` | L1 (상한 초과: L2) |
| POST | `/users/:publicId/currencies/deduct` | 회수 `{ currencyCode, amount, reason, confirmationToken? }` 🔁📝 | `currency:deduct` | L2 |
| POST | `/currencies/bulk-grant` | 다수 회원 지급 — 행별 `{ entries[≤3000]: { publicId, currencyCode?, amount, reason? }, currencyCode?, reason? }` (행에 비운 재화·사유는 요청 값으로 채움, 같은 회원에게 여러 재화 가능, 회원+재화 조합 중복 불가, 최대 1,000명, 사유는 행마다 원장·감사 로그에 기록) 또는 전원 같은 지급 `{ publicIds[≤1000], currencyCode, amount, reason }`. 서버에서 entries 로 정규화. 422: `INVALID_CURRENCY`(`details.invalidCurrencies`), `EXCEEDS_GRANT_LIMIT`(`details.overLimit[{publicId,currencyCode,amount,limit}]`), `USER_NOT_FOUND`/`USER_WITHDRAWN`. 응답 `{ count(건), userCount, totals[{currencyCode, amount}] }` 🔁📝 | `currency:grant` | L1 (서로 다른 회원 100명↑: **L3 웹 전용**) |
| GET | `/currency-transactions` | 전체 재화 이력 `?adminId&currencyCode&source&from&to&cursor` | `currency:read` | L0 |

### 2.6 우편 (mails)

| Method | Path | 설명 | 권한 | 위험 |
|---|---|---|---|---|
| GET | `/items` | 아이템 마스터 (보상 선택용) | `mail:read` | L0 |
| GET | `/mails` | 발송 이력 `?type&status&createdBy&from&to` | `mail:read` | L0 |
| GET | `/mails/:mailId` | 상세 (보상, 수령 통계) | `mail:read` | L0 |
| GET | `/mails/:mailId/recipients` | 수신자별 수령 상태 | `mail:read` | L0 |
| POST | `/mails` | 개별 발송 `{ publicIds[≤1000], title, body, rewards[≤10], expiresInDays, reason }` 🔁📝 | `mail:send` | L1 |
| POST | `/mails/global` | 전체 발송 `{ title, body, rewards, expiresInDays, targetFilter?, reason }` 🔁📝 | `mail:send_all` | **L3 웹 전용** |
| POST | `/mails/:mailId/cancel` | 발송 취소(미수령분 무효화) 📝 | `mail:send` (전체: `mail:send_all`) | L2 |
| GET | `/users/:publicId/mails` | 회원 우편함 | `mail:read` | L0 |

### 2.7 랭킹 (rankings)

| Method | Path | 설명 | 권한 | 위험 |
|---|---|---|---|---|
| GET | `/ranking-boards` | 랭킹 종류(보드) 목록 — 아레나·월드아레나 | 로그인 | L0 |
| GET | `/ranking-seasons` | 시즌 목록 (각 시즌에 `board`) | `ranking:read` | L0 |
| GET | `/ranking-seasons/:seasonId/rankings` | 랭킹 `?offset=0&limit=100` | `ranking:read` | L0 |
| GET | `/ranking-seasons/:seasonId/rankings/users/:publicId` | 회원 순위 + 주변 ±5 | `ranking:read` | L0 |
| POST | `/ranking-seasons/:seasonId/rebuild` | MySQL 기준 Redis 재구성 🔁📝 | `ranking:manage` | L1 |
| POST | `/ranking-seasons/:seasonId/reset` | 초기화 (스냅샷 후) 🔁📝 | `ranking:manage` | **L3 웹 전용** |
| GET | `/ranking-seasons/:seasonId/snapshots` | 스냅샷 목록/조회 | `ranking:read` | L0 |
| GET | `/ranking-seasons/:seasonId/snapshots/:snapshotId/export` | 스냅샷 CSV (UTF-8 BOM, 수식 주입 방지, 5,000행씩 스트리밍) 📝 | `ranking:read` | L0 |
| POST | `/ranking-seasons/:seasonId/restore` | 스냅샷 복원(교체) `{ snapshotId, reason }` — 직전 순위는 BACKUP 스냅샷으로 자동 보관 🔁📝 | `ranking:manage` | **L3 웹 전용** |
| POST | `/ranking-seasons/:seasonId/rewards` | 스냅샷 순위 보상 우편 `{ snapshotId, title(≤38), body, expiresInDays, tiers[≤20]: { fromRank, toRank(null=마지막까지), rewards[] }, reason }` — 구간마다 우편 1통, 한 번에 최대 100,000명, 탈퇴 회원 제외, 스냅샷당 1회(409 `SNAPSHOT_REWARD_EXISTS`) 🔁📝 | `ranking:manage` | **L3 웹 전용** |

### 2.7.1 스케줄·이미지 (schedules, assets) — docs/schedule.md

| Method | Path | 설명 | 권한 | 위험 |
|---|---|---|---|---|
| GET | `/schedules?from&to&kind&includeCanceled` | 기간과 겹치는 일정 (상태는 시각으로 계산) | `schedule:read` | L0 |
| GET | `/schedules/:id` | 일정 상세 | `schedule:read` | L0 |
| POST | `/schedules` | 일정 등록 `{ kind(RANKING_SEASON\|EVENT), rankingBoardId(시즌 필수), title, description, startsAt, endsAt, popupEnabled, popupFrequency, bannerEnabled, priority, imageAssetId, link(game://·https://), reason }` — 시즌은 랭킹 시즌을 함께 생성(예정), **같은 보드** 시즌 기간 겹침 409 `SCHEDULE_OVERLAP` 🔁📝 | `schedule:manage` | L1 |
| PUT | `/schedules/:id` | 수정 (전체 값 + `version`). 시작 전 L1 / **진행 중 L2**(시작 시각 변경 불가) / 종료·취소 422 `SCHEDULE_NOT_EDITABLE` / 버전 불일치 409 `VERSION_CONFLICT` 📝 | `schedule:manage` | L1·**L2** |
| POST | `/schedules/:id/cancel` | 취소 `{ reason, version }` — 시작 전 L1, 진행 중 이벤트 "내리기" **L2**, 진행 중 시즌 불가 📝 | `schedule:manage` | L1·**L2** |
| POST | `/schedules/:id/end-now` | 진행 중 시즌 조기 종료 — 즉시 종료 + FINAL 스냅샷 📝 | `schedule:manage` | **L2** |
| POST | `/assets` | 이미지 업로드 (본문 = 파일 바이트, `X-File-Name`) — 매직 바이트로 PNG·JPEG·WebP 판별, SVG 불가, 2MB·2048px, 같은 파일은 같은 id 📝 | `schedule:manage` | L1 |
| GET | `/assets/:id` | 이미지 정보 | `schedule:read` | L0 |
| GET | `/public/assets/:key` | 이미지 파일 (인증 없음, nosniff, 영구 캐시) | - | - |

### 2.7.2 점검·공지 (maintenances, notices) — docs/maintenance-notice.md

| Method | Path | 설명 | 권한 | 위험 |
|---|---|---|---|---|
| GET | `/maintenances/current` | 지금 점검 상태 `{ active, maintenanceId, title, message, endsAt, sessionEpoch }` (상단 띠용) | 로그인 | L0 |
| GET | `/maintenances?page&size` | 점검 목록 (상태는 시각으로 계산) | `notice:read` | L0 |
| GET | `/maintenances/:id` | 점검 상세 | `notice:read` | L0 |
| POST | `/maintenances` | 예약 `{ title, message, startsAt, endsAt, allowPublicIds[≤100], createNotice, reason }` (L1) / **긴급** `startNow: true` (L2 — 최근 30분 접속자 수 미리보기). 기간 겹침 409 `MAINTENANCE_OVERLAP`, 지난 시작 시각 422 🔁📝 | `maintenance:manage` | L1·**L2** |
| PUT | `/maintenances/:id` | 수정 (전체 값 + `version`). 시작 전 L1 / 진행 중: 시작 시각 고정, 종료 변경(연장·단축) **L2**, 문구·예외 회원만이면 L1. 점검 공지 자동 동기화 📝 | `maintenance:manage` | L1·**L2** |
| POST | `/maintenances/:id/cancel` | 시작 전 취소 `{ reason, version }` — 점검 공지도 내림. 진행 중이면 422 📝 | `maintenance:manage` | L1 |
| POST | `/maintenances/:id/open-now` | 진행 중 점검 지금 열기 — 즉시 차단 해제, 점검 공지 게시 종료 📝 | `maintenance:manage` | **L2** |
| GET | `/notices?page&size&category&includeHidden` | 공지 목록 | `notice:read` | L0 |
| GET | `/notices/:id` | 공지 상세 | `notice:read` | L0 |
| POST | `/notices` | 등록 `{ category(NOTICE\|UPDATE\|EVENT\|MAINTENANCE), title≤60, body≤5000(평문), startsAt, endsAt(null=계속), pinned, tickerEnabled, tickerText≤80, reason }` 🔁📝 | `notice:manage` | L1 |
| PUT | `/notices/:id` | 수정 (+`version`) 📝 | `notice:manage` | L1 |
| POST | `/notices/:id/hide` | 내리기 `{ reason, version }` 📝 | `notice:manage` | L1 |

### 2.8 승인 요청 (approvals) — 2026-11-16 제거

4-eyes 승인 기능을 없앴다. L3 작업은 웹 전용 강한 확인으로 바로 실행된다 (1.2 참고).

### 2.9 운영 로그 (audit-logs)

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/audit-logs` | 목록 `?adminId&action&targetType&targetId&channel&result&from&to&cursor` | `audit:read` |
| GET | `/audit-logs/:id` | 상세 (before/after diff) | `audit:read` |

CS 역할처럼 "본인 작업만" 조회 가능한 경우, 서비스 계층에서 `adminId` 필터를 강제한다.

### 2.10 대시보드 (dashboard)

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/dashboard/summary` | 오늘(KST) KPI — DAU, NRU, 정지 회원, 재화별 발행/소모, 어제 값 | `dashboard:read` |
| GET | `/dashboard/trends` | `?metric=dau\|nru\|suspendedTotal&from&to` 일별 추이 (YYYY-MM-DD, 최대 90일, 기본 최근 30일) | `dashboard:read` |
| GET | `/dashboard/currency-flows` | `?currencyCode&from&to` 일별 발행/소모 | `dashboard:read` |

결과는 Redis에 60초 캐시.

### 2.10-1 유저 분석 (analytics) — docs/analytics.md

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/analytics/churn` | `?inactiveDays=7` 스테이지 구간별 도달·멈춤·이탈·이탈률 | `analytics:read` |
| GET | `/analytics/retention` | `?from&to` 가입 코호트 D1·3·7·14·30 재접속률 (최대 90일) | `analytics:read` |
| GET | `/analytics/purchases` | `?from&to` 매출·결제자·결제율·ARPPU·첫 결제 구간/경과일·상품별 | `analytics:read` |
| GET | `/analytics/spending` | `?from&to&currencyCode` 게임 안 소비 사유별·구간별 | `analytics:read` |

결과는 Redis에 10분 캐시.

### 2.10-2 이메일 (emails) — docs/email.md

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/emails` | 발송 기록 `?status&page&size` | `email:read` |
| GET | `/emails/limits` | SMTP 설정 여부, 체험 계정 제한 | `email:read` |
| GET | `/emails/:id` | 상세 | `email:read` |
| GET | `/emails/:id/deliveries` | 수신자별 결과 (주소 마스킹) | `email:read` |
| POST | `/emails/preview` | 실제·가상·제외 인원 미리보기 | `email:send` |
| POST | `/emails/render` | 보낼 디자인 그대로 제목·HTML (메일 미리보기) | `email:send` |
| POST | `/emails` | 발송 `{ target: USERS\|ALL\|ADDRESS, subject, body, isAd, scheduledAt?, reason }` — 전체·100명↑ L3(웹 전용), 주소 직접 입력은 웹 전용 | `email:send` (+ 전체 `email:send_all`) |
| POST | `/emails/:id/cancel` | 예약 취소 | `email:send` |

### 2.11 시스템

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/health/live` | 프로세스 생존 | 공개 |
| GET | `/health/ready` | DB·Redis 연결 | 공개 (내부망 한정 권장) |
| GET | `/docs` | OpenAPI UI | 개발 환경에서만 노출 |

### 2.12 시뮬레이터 전용 (게임 서버 역할 대체) ⚠️

운영자 인증이 아닌 **내부 키(`X-Internal-Key`)** 로 보호되며 재화를 만들 수 있는 경로다. `INTERNAL_API_KEY` 가 비어 있거나 `NODE_ENV=production` 이면 **라우터 자체를 등록하지 않는다** (404).

| Method | Path | 설명 |
|---|---|---|
| GET | `/internal/game/users/sample?size=50&recentDays=` | 활동 중인 회원 무작위 샘플 `[{ publicId, maxStage, payCount }]` (recentDays: 최근 접속·가입 회원만) |
| POST | `/internal/game/purchases` | 가상 결제 `{ publicId, productCode }` → 결제 기록 + 유료 젬 지급(원장 source=PURCHASE) |
| GET | `/internal/game/products` | 상품 목록 |
| POST | `/internal/game/events` | 활동 이벤트 배치(≤500) — 정지·탈퇴 회원 이벤트는 거부해 `rejected` 로 반환, LOGIN 은 `last_login_at`, STAGE_CLEAR(`payload.stage`) 는 `max_stage` 갱신 |
| POST | `/internal/game/scores` | 랭킹 점수 기록 `{ publicId, score, seasonId? , boardCode? }` — 보드 코드면 그 보드의 진행 중 시즌, 둘 다 없으면 진행 중 시즌이 하나일 때만. 진행 중이 아니거나 모호하면 422 `SEASON_NOT_ACTIVE` |
| GET | `/internal/game/live-ops?at=` | 지금(또는 at) 게임에 보일 것: 보드별 진행 중 시즌(`seasons[]`)·이벤트·팝업·배너 (우선순위 순) + `maintenance`(진행 중 점검)·`sessionEpoch`(세션 세대 — 오르면 접속 중 유저를 끊음)·`tickers[]`(≤5). 점검 중에도 열림 |
| GET | `/internal/game/notices` | 게시 중 공지 (고정 → 최신). 점검 중에도 열림 |
| POST | `/internal/game/currencies` | 게임 내 재화 획득(+)·소비(−), 원장 source=GAME |
| GET | `/internal/game/users/:publicId/mails` | 회원 우편함 |
| POST | `/internal/game/mails/:mailId/claim` | 우편 수령 |

> **점검 중**: `events`·`scores`·`currencies`·우편 수령은 503 `MAINTENANCE` (`details.endsAt`). 점검의 예외 회원은 통과. `events` 묶음은 예외 회원이 섞이면 막힌 회원만 `rejected: MAINTENANCE`, 전원이 막히면 503
