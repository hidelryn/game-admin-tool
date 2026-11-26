# 이메일 발송

> 2026-11-26 추가. 메뉴 "이메일"(`/emails`), 권한 `email:read`·`email:send`·`email:send_all`, MCP Tool 2개. 푸시는 범위에서 제외.

## 1. 결정 사항 (사용자 승인)

| 항목 | 결정 |
|---|---|
| 채널 | 이메일만 (푸시 제외) |
| 실제 발송 | 무료 SMTP 서비스로 실제 발송 — 추천 **Brevo** (무료 하루 300통, 발신 주소 1개 인증만으로 사용, 무료 메일엔 Brevo 로고) |
| 체험 계정 | 회원 대상(지정·전체) 발송은 **가상 발송**, **주소 직접 입력 1건은 실제 발송** — 문구는 자유, 링크 금지·길이·횟수 제한 |

## 2. 실제로 보내는 것 / 가상 발송

회원 주소는 모두 가상(`@example.com`)이라 보내면 반송되고, 반송이 쌓이면 SMTP 계정이 막힌다. 그래서 **실제 SMTP 발송은 아래 두 경우만**, 나머지는 결과를 `VIRTUAL`(가상 발송)로 기록만 남긴다. 대상 계산·동의 확인·기록·통계는 실제와 똑같이 동작한다.

1. **주소 직접 입력 1건** (`ADDRESS`)
2. 회원 대상이지만 회원 주소가 `EMAIL_REAL_ALLOWLIST` 에 있고, 만든 운영자가 **체험 계정이 아님**

SMTP 4개 값이 없으면 전부 가상 발송.

## 3. 대상과 안전장치

| 대상 | 처리 | 안전장치 |
|---|---|---|
| 회원 지정 99명까지 | 바로 (Worker·API 백그라운드가 처리, 1분 안) | L1 |
| 회원 지정 100명 이상 · 전체 회원 | 바로 또는 예약 | **L3** — 웹 전용 빨간 경고 확인 (대상·실제/가상·제외 인원). 전체는 `email:send_all` 필요 |
| 주소 직접 입력 1건 | 요청 안에서 바로 보내고 결과 반환. 예약·광고 불가 | **웹 전용** — MCP(API 토큰)는 403. AI 가 임의 외부 주소로 데이터를 내보내는 통로가 되지 않게 |

- 모든 발송: Idempotency-Key(중복 방지), 감사 로그(`EMAIL_SEND`·`EMAIL_SEND_ALL`·`EMAIL_CANCEL`, 주소는 마스킹), 사유 필수
- 예약 발송은 시각 전까지 취소(L1). 보내기 시작한 건 되돌릴 수 없다
- 하루 실제 발송 상한 `EMAIL_DAILY_REAL_LIMIT`(기본 250, Brevo 무료 300 보호). 넘으면 `FAILED`. Redis 장애면 보내지 않음(fail-closed)

### 광고성 메일 (실무 규칙 참고)

- 제목 앞에 `(광고) `, 본문 끝에 수신 동의 해제 안내
- 회원의 **광고성 이메일 수신 동의**(`users.ad_email_opt_in`)가 없으면 `SKIPPED_NO_CONSENT`
- **야간(21시~다음 날 8시, KST)** 에는 **야간 수신 동의**(`night_opt_in`)가 없으면 `SKIPPED_NIGHT` — 판정 시각은 실제 처리 시각(예약이면 예약 시각 기준으로 미리보기)
- 주소 직접 입력은 수신 동의를 확인할 수 없어 광고로 보낼 수 없다
- 국내 정보통신망법의 광고성 정보 전송 규칙(사전 동의·(광고) 표기·야간 별도 동의)을 참고한 것으로, 실제 서비스라면 법무 검토가 필요하다

### 체험 계정 (공개 계정 악용 방지)

| 제한 | 값 |
|---|---|
| 회원 대상 발송 | 허용 목록 주소여도 **가상 발송** |
| 주소 직접 입력 | IP 당 1시간 3통(`DEMO_EMAIL_PER_IP_HOUR`), 같은 주소 하루 1통, 체험 계정 전체 하루 50통(`DEMO_EMAIL_DAILY_LIMIT`) |
| 내용 | 본문 1,000자, **링크·웹 주소 금지**, 제목에 `[Game Admin 체험]`, 본문 끝에 "체험 기능으로 방문자가 입력한 주소" 안내 |

⚠️ 문구를 자유롭게 둔 만큼 스팸·장난 메일에 쓰일 위험은 남는다. 링크 금지·횟수 제한·발신 표시로 줄였고, 감사 로그로 추적한다. 문제가 생기면 `DEMO_EMAIL_DAILY_LIMIT=0` 으로 바로 막을 수 있다.

## 4. 처리 흐름

```
POST /emails ─ 검증·권한·체험 제한 → (L3 면 확인 토큰) → email_campaigns 1행 + 감사 로그 (같은 트랜잭션)
   ├ 주소 직접 입력: 같은 요청에서 SMTP 발송 → email_deliveries 1행 → 완료
   └ 회원 대상: SCHEDULED
        ├ 바로: API 가 백그라운드로 처리 시작
        └ 예약: Worker "email-dispatch"(1분)가 시각이 된 것을 가져감
     가져가기 = 조건부 UPDATE SCHEDULED→SENDING (여러 프로세스여도 한 곳만)
     회원 500명씩: 동의·야간·활동 판정 → (허용 목록이면 SMTP) → email_deliveries 일괄 기록
     → 집계 후 DONE
```

- 처리하다 프로세스가 죽으면 10분 뒤 Worker 가 다시 가져가 **아직 기록이 없는 회원부터** 이어서 처리 (`UNIQUE(campaign_id, user_id)` 로 중복 발송 방지)

## 5. 데이터

| 표 | 내용 |
|---|---|
| `email_campaigns` | 대상(유형·회원 ID 목록·직접 주소), 제목·본문(평문), 광고 여부, 상태, 예약·시작·완료·취소 시각, 체험 계정 여부, 결과 집계(전체·실제·가상·제외·실패), 사유·운영자·채널 |
| `email_deliveries` | 수신자별 결과 (append only, FK 없음): 회원·주소·상태·오류·message-id. `UK(campaign_id, user_id)` |
| `users.ad_email_opt_in`, `users.night_opt_in` | 광고성 메일 수신 동의, 야간 수신 동의 (시드: 약 55%, 그중 20%) |

## 6. API · MCP

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | `/emails` | 발송 기록 (`?status&page&size`) | `email:read` |
| GET | `/emails/limits` | SMTP 설정 여부, 체험 계정 제한 | `email:read` |
| GET | `/emails/:id` | 상세 (본문 포함) | `email:read` |
| GET | `/emails/:id/deliveries` | 수신자별 결과 (주소 마스킹, `?status`) | `email:read` |
| POST | `/emails/preview` | 지금 보내면 실제·가상·제외 인원 (아무것도 안 보냄) | `email:send` |
| POST | `/emails` | 발송 (Idempotency-Key 필수, L3 는 confirmationToken) | `email:send` (전체는 `email:send_all`) |
| POST | `/emails/:id/cancel` | 예약 취소 | `email:send` |

- 권한: 최고 관리자 전부 / 운영자 read·send·send_all / 고객지원 read·send / 조회 전용 read. 체험 계정 토큰은 `email:read` 만
- MCP: `send_email`(회원 지정 99명까지 실행, 전체·100명 이상은 WEB_ONLY, 주소 직접 입력 없음), `list_email_campaigns`

## 7. 설정 (`.env`)

```bash
# Brevo 예: SMTP & API → SMTP 탭의 로그인·키, 발신 주소는 Senders 에서 인증
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<Brevo SMTP 로그인>
SMTP_PASS=<Brevo SMTP 키>
MAIL_FROM="Game Admin <인증한-주소@gmail.com>"
EMAIL_REAL_ALLOWLIST=            # 회원 대상 발송 중 실제로 보낼 주소 (쉼표)
EMAIL_DAILY_REAL_LIMIT=250
DEMO_EMAIL_DAILY_LIMIT=50
DEMO_EMAIL_PER_IP_HOUR=3
```

SMTP 키는 비밀값 — `.env`(로컬·서버)에만 두고 저장소·채팅에 올리지 않는다. 4개(HOST·USER·PASS·MAIL_FROM)는 모두 채우거나 모두 비워야 기동된다.

## 8. 디자인 틀 (2026-11-26)

운영자는 **평문만** 쓰고, 서버가 보낼 때 정해진 틀에 넣는다 (`apps/api/src/modules/emails/email-template.ts`).

- 구성: 상단 배너(GAME ADMIN · 게임 운영 알림) → (광고 표시) → 제목 → 본문 문단(빈 줄로 나눔) → 버튼(선택) → 하단 안내
- 메일 앱 호환: 표 레이아웃 + 인라인 스타일만, 외부 CSS·스크립트·이미지 없음. 평문 버전도 같이 보낸다 (버튼은 "문구: 링크")
- 안전: 모든 입력은 HTML 이스케이프, 버튼 링크는 `https://` 만, 체험 계정은 버튼 불가
- 작성 화면 "메일 미리보기": `POST /emails/render` 가 실제 보낼 제목·HTML 을 돌려주고, 웹은 스크립트가 막힌 iframe(sandbox)으로 보여 준다
