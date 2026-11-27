# Game Admin — 게임 운영 백오피스 + MCP 서버

게임 운영자가 **웹 백오피스**와 **AI 클라이언트(MCP)** 양쪽에서 같은 운영 기능(회원 관리, 재화 지급·회수, 우편, 랭킹, 운영 로그)을 안전하게 사용할 수 있도록 만든 포트폴리오 프로젝트입니다.

> 현재 상태: **배포 완료** — https://game-admin-delryn.duckdns.org (체험 계정은 로그인 화면에 공개, docs/deployment.md). API 커버리지 92% — API·Worker·시뮬레이터, 웹 백오피스(회원·재화·우편·이메일·랭킹·스케줄·점검/공지·운영 로그·대시보드·유저 분석·AI 어시스턴트), MCP 서버(Tool 23개)

## 핵심 포인트

- 백오피스와 MCP가 **하나의 서비스 계층**을 공유 (MCP는 DB에 직접 접근하지 않음)
- 재화 변경은 트랜잭션 + 행 잠금 + 원장 기록, **Idempotency Key**로 중복 지급 방지
- 위험 작업은 **확인 토큰** 2단계, 대규모 작업은 **웹 전용 빨간 경고 확인** (MCP 는 미리보기만)
- 모든 변경은 채널(WEB/MCP)이 구분된 **감사 로그**에 기록
- RBAC + 운영자별 권한 Override, MCP용 최소 권한 API 토큰

## 기술 스택

Node.js · TypeScript · Express · MySQL · Redis · React · Vite · MCP TypeScript SDK · Docker Compose · GitHub Actions

## 문서

| 문서 | 내용 |
|---|---|
| [요구사항](docs/requirements.md) | 기능/비기능 요구사항 |
| [아키텍처](docs/architecture.md) | 구조, 기술 선택, 인증·권한, 보안, 예외 처리 |
| [데이터베이스](docs/database.md) | ERD, 인덱스, 데이터 흐름 |
| [API 명세](docs/api-specification.md) | REST API 목록 |
| [MCP Tool](docs/mcp-tools.md) | Tool 명세 |
| [테스트](docs/testing.md) | 테스트 전략·실행 방법·결과 |
| [이메일 발송](docs/email.md) | 실제 발송(무료 SMTP)·가상 발송, 수신 동의·야간 제한, 체험 계정 제한 |
| [AI 어시스턴트](docs/ai-assistant.md) | 자연어 질문 → AI 가 조회 기능을 골라 데이터 조회 → 요약·차트 (조회 전용·권한 상속·차트 숫자 검증) |
| [유저 분석](docs/analytics.md) | 이탈 구간·리텐션·과금·재화 소비처, 가상 플레이 모델 |
| [체험 모드](docs/demo-mode.md) | 공개 체험 계정, 매일 초기화, 메뉴 투어 |
| [배포](docs/deployment.md) | CI(GitHub Actions)·이미지(GHCR)·EC2 수동 배포·백업 |
| [개발 로그](docs/development-log.md) | 진행 기록, 결정 사항, 일정 |
| 배포 | `docs/deployment.md` — Phase 7에서 작성 |

## 실행 방법 (로컬)

### 준비물

- Node.js 22 이상
- npm 10 이상 (Node 22에 기본 포함)
- Docker Desktop

### 1. 설치

```bash
npm install
cp .env.example .env          # Windows cmd/PowerShell: copy .env.example .env
```

`.env`에서 아래 두 값은 **반드시** 채워야 합니다.

| 항목 | 설명 |
|---|---|
| `JWT_ACCESS_SECRET` | 32자 이상 랜덤 문자열. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` 로 생성 |
| `SEED_ADMIN_PASSWORD` | 시드 운영자 공통 초기 비밀번호 (10자 이상, 영문·숫자 포함) |

### 2. DB 준비 + 개발 모드 실행

```bash
npm run infra:up              # MySQL·Redis 컨테이너 실행
npm run db:generate           # 스키마 → 마이그레이션 SQL 생성 (스키마가 바뀔 때만)
npm run db:migrate            # 마이그레이션 적용
npm run db:seed               # 역할·권한·재화·운영자 기준 데이터
npm run db:seed:game          # 가상 회원·활동·잔액 (기본 1천 명, --scale=medium|large, 다시 만들 땐 --reset)
npm run dev                   # api(:4000) · web(:5173) · worker 동시 실행
npm run simulate              # (선택) 게임 이벤트 생성 — .env 에 INTERNAL_API_KEY 필요, 다른 터미널에서
```

- 백오피스: http://localhost:5173
- 시드 운영자: `super@example.com`, `operator@example.com`, `cs@example.com`, `viewer@example.com` (비밀번호 = `SEED_ADMIN_PASSWORD`)

### 3. 전체를 컨테이너로 실행 (운영과 같은 방식)

```bash
docker compose --profile app up -d --build
```

- 백오피스: http://localhost:8080 (Nginx가 `/api`를 API 컨테이너로, `/mcp`를 MCP 컨테이너로 프록시)

### 4. MCP 서버 연결 (AI 클라이언트)

1. 웹 백오피스 → **API 토큰**에서 토큰 발급 (필요한 권한만 체크, 토큰은 한 번만 보임)
2. MCP 서버 실행: `npm run dev:mcp` → `http://127.0.0.1:4100/mcp` (컨테이너면 `http://localhost:8080/mcp`)
3. 클라이언트 등록 (Claude Code 예):

```bash
claude mcp add --transport http game-admin http://127.0.0.1:4100/mcp --header "Authorization: Bearer <API 토큰>"
```

- 확인: `npx @modelcontextprotocol/inspector` → Streamable HTTP, 위 URL, 헤더 `Authorization: Bearer <API 토큰>`
- 로컬 stdio: `.env` 에 `GAME_ADMIN_API_TOKEN` 설정 후 `npm run dev:mcp:stdio`
- 토큰 권한에 없는 Tool 은 목록에 나오지 않습니다. 대량 지급(100명↑)·전체 우편·랭킹 초기화/복원/보상은 MCP 로 실행되지 않고 미리보기만 돌려줍니다 (`WEB_ONLY`)

### 주의

- MySQL 컨테이너는 **처음 생성될 때만** `.env` 의 계정·비밀번호를 사용합니다. 나중에 `.env` 비밀번호를 바꾸면 접속이 거부되므로, `docker compose down -v` 로 데이터 볼륨까지 지우고 다시 `infra:up` → `db:migrate` → 시드를 실행하세요.

- `.env` 는 서버가 **시작할 때 한 번만** 읽습니다. 값을 바꾸면 `npm run dev` 를 껐다 켜야 반영됩니다 (`tsx watch` 는 코드 변경만 감지).

### 자주 쓰는 명령

특정 워크스페이스에 패키지 추가: `npm install <패키지> -w @game-admin/api`


| 명령 | 설명 |
|---|---|
| `npm run typecheck` | 전체 타입 검사 |
| `npm test` | 단위 테스트 — api·mcp·web (외부 의존성 없음) |
| `npm run coverage` | 커버리지 (api 단위+통합, mcp) — Docker 필요 |
| `npm run test:integration` | 통합 테스트 — Testcontainers 로 실제 MySQL·Redis 를 띄워 실행 (Docker 필요) |
| `npm run lint` | ESLint |
| `npm run db:generate` | 스키마 변경 → 마이그레이션 파일 생성 |
| `npm run db:migrate` | 마이그레이션 적용 |
| `npm run db:seed` | 기준 데이터 시드 (여러 번 실행해도 안전) |
| `npm run db:seed:game -- --scale=medium --reset` | 게임 데이터 다시 생성 (회원 1만 명) |
| `npm run simulate -- --users=100 --interval=3` | 시뮬레이터: 3초마다 100명이 로그인·클리어·재화·점수·우편 수령 |
| `npm run infra:down` | 컨테이너 중지 (데이터 볼륨은 유지) |

## 디렉터리

```
apps/api       Express API 서버 + Worker(src/worker.ts) + 시드·시뮬레이터 스크립트
apps/web       React 백오피스
apps/mcp       MCP 서버 (API 만 호출, DB 접근 없음)
packages/shared  서버·웹·MCP 공용 타입/상수
docker/        Dockerfile, Nginx(로컬·운영 TLS), MySQL 설정
deploy/        운영 Compose, 배포 스크립트, 운영 .env 양식
.github/       CI·배포 워크플로
docs/          설계 문서
```
