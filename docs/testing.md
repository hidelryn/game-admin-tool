# 테스트 전략과 실행 방법

> Phase 6 (2026-11-16) 완료

## 1. 원칙

- **실제 DB·Redis 로 검증**: 돈(재화)·권한·중복 실행처럼 사고가 나면 안 되는 규칙은 목(mock) 대신 Testcontainers 로 띄운 MySQL 8.4·Redis 7.4 에서 실제 트랜잭션·잠금·유니크 제약으로 확인한다.
- **규칙은 표로**: 권한(역할 × API)처럼 빠뜨리기 쉬운 규칙은 표 하나에서 모든 경우를 만들어 검사한다. 역할-권한 표나 라우터가 바뀌면 테스트가 바로 알려 준다.
- **경계마다 한 번씩**: 웹(파일 파서) → MCP(Tool 변환) → API(권한·검증·안전장치) → DB 를 각각 테스트하고, MCP → 실제 API 끝-끝 테스트로 이음새를 확인한다.
- **동시성은 실제로 동시에**: 같은 요청을 `Promise.all` 로 동시에 보내 결과가 한 번만 반영되는지 본다.

## 2. 구성

| 층 | 위치 | 도구 | 외부 의존 |
|---|---|---|---|
| API 단위 | `apps/api/test/unit` | Vitest | 없음 |
| API 통합 | `apps/api/test/integration` | Vitest + Supertest + Testcontainers | Docker |
| MCP | `apps/mcp/test` | Vitest + MCP SDK 인메모리 클라이언트 + 가짜 API | 없음 |
| MCP 끝-끝 | `apps/api/test/integration/mcp-e2e.test.ts` | MCP SDK 클라이언트 → MCP 서버 코드 → 실제 API(HTTP) | Docker |
| 웹 단위 | `apps/web/test` | Vitest (화면 없이 순수 함수) | 없음 |

## 3. CLAUDE.md Phase 6 항목별 위치

| 항목 | 주요 테스트 |
|---|---|
| 단위 테스트 | `api/test/unit/*` (비밀번호 해시, 토큰, 시간 계산, 랭킹 번호·멤버 인코딩, 이미지 판별, 대량 지급 검증, 점검·공지 상태), `web/test/*` (CSV·엑셀 파서, 대량 지급 파일 검증, 로그인 후 경로) |
| API 통합 테스트 | `auth`, `admins`, `api-tokens`, `users`, `currencies`, `mails`, `rankings`, `schedules`, `live-notices`, `dashboard`, `audit-logs`, `internal-game` |
| MCP Tool 테스트 | `mcp/test/tools.test.ts`(Tool 17개 변환·검증), `mcp/test/server.test.ts`(토큰 확인·목록·HTTP), `api/test/integration/mcp-e2e.test.ts`(실제 API) |
| 권한 검증 테스트 | **`permissions-matrix.test.ts`** — 보호된 API 80여 개 × 역할 4개, 인증 없음 401, API 토큰 범위·채널·금지 권한 |
| 예외 상황 테스트 | **`safety.test.ts`** — Redis 장애(위험 작업 503, 일반 지급은 DB 로 보호, 랭킹만 503), 404·깨진 JSON·검증 실패 형식 / 각 기능 테스트의 잔액 부족·탈퇴 회원·기간 겹침·버전 충돌 등 |
| 중복 실행 방지 테스트 | **`safety.test.ts`** — 생성 API 4종 × (키 없음 400, 같은 키 동시 8회 → 1건, 재전송 같은 결과, 내용 바꾸면 422, 운영자별 키) / 확인 토큰 1회용·다른 운영자·만료·바꿔치기 / `currencies`·`mails`·`rankings` 의 동시 지급·수령·보상 |

## 4. 실행

```bash
npm test                      # 단위 (api·mcp·web) — Docker 불필요
npm run test:integration      # API 통합 + MCP 끝-끝 — Docker 필요
npm run coverage              # 커버리지 (api: 단위+통합, mcp) → apps/*/coverage/index.html
npm run typecheck && npm run lint
```

- 통합 테스트는 컨테이너 하나를 공유하므로 파일 단위 병렬 실행을 끈다 (`fileParallelism: false`). 매 테스트 전 테이블 비우기 + 기준 데이터 시드.
- 마이그레이션 파일이 없으면 통합 테스트가 시작되지 않는다 (`npm run db:generate`).

## 5. 모의(mock)를 쓴 곳과 이유

| 대상 | 방법 | 이유 |
|---|---|---|
| Redis 장애 | `vi.spyOn(redis, 'sendCommand')` 로 모든 명령 실패 | 컨테이너를 멈추면 다른 테스트에 영향. 명령 단위로 끊어 같은 효과 |
| 확인 토큰 만료 | Redis 에서 토큰 키 삭제 | 5분 대기 대신 |
| MCP 단위 테스트의 API | 경로별 응답 표(`fake-api.ts`) | Tool 의 입력 검증·응답 변환만 빠르게. 실제 API 와의 연결은 끝-끝 테스트가 담당 |
| 업로드 저장소 | 메모리 저장소 | 디스크 정리 불필요 |

## 6. 일부러 테스트하지 않은 것

- 화면 컴포넌트·사용자 흐름(E2E 브라우저 테스트): 포트폴리오 범위에서 비용 대비 효과가 낮아 수동 확인으로 대체 (개발 로그의 "화면 확인")
- 실제 게임 서버의 세션 끊기: 신호(세션 세대)만 제공하므로 시뮬레이터 로그로 확인
- 부하·성능: Phase 7 배포 후 필요하면 별도

## 7. 결과

| 항목 | 결과 |
|---|---|
| 테스트 | 단위(api·mcp·web)·통합·MCP 끝-끝 전체 통과 (2026-11-16) |
| API 커버리지 (단위+통합) | 줄 92.4% (7,322/7,928) · 분기 85.4% · 함수 97.9% (2026-11-16) |
| MCP 커버리지 | 줄 76.3% (855/1121) · 분기 68.7% · 함수 80.4% (2026-11-16) |
| 타입 검사·lint·prettier | 통과 |
