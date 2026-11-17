# 배포 (Phase 7)

> 상태: **구성 완료 — 저장소·서버 미생성** (2026-11-16). GitHub 저장소와 도메인이 아직 없어서 이름은 자리표시(`<owner>/<repo>`, `<도메인>`)로 적었다.

## 0. 한눈에 보기

```
개발 PC ──git push──▶ GitHub ──Actions(CI)──▶ 형식·lint·타입·단위 → 통합(MySQL·Redis 컨테이너)+커버리지
                                               └ main 이면 이미지 4개 빌드 → GHCR(ghcr.io/<owner>/<repo>/{api,worker,web,mcp}:<커밋>)
운영자 ──Actions 탭 "Deploy" 실행(태그 지정)──▶ (승인) ──SSH──▶ EC2 /opt/game-admin/deploy.sh
                                                                    이미지 받기 → 마이그레이션 → 교체 → 상태 확인 → 실패 시 이전 태그
인터넷 ──443──▶ EC2 Nginx(web) ─┬─ /        정적 웹
                                ├─ /api/    api:4000 ─┬─ mysql (외부 비공개)
                                └─ /mcp     mcp:4100 ─┘  redis (외부 비공개)
                                worker (시즌·점검·KPI 작업), certbot (인증서 갱신)
```

| 파일 | 역할 |
|---|---|
| `.github/workflows/ci.yml` | PR·main 푸시: 검사·테스트 / main: 이미지 빌드·GHCR 푸시 |
| `.github/workflows/deploy.yml` | 수동 배포 (태그 입력 → `production` 환경 승인 → SSH) |
| `deploy/docker-compose.prod.yml` | 운영 구성 (이미지만 받아 실행, 빌드 없음) |
| `deploy/deploy.sh` | 서버에서 실행하는 배포 순서 + 자동 되돌리기 |
| `deploy/.env.prod.example` | 서버 `.env` 양식 |
| `docker/nginx/prod.conf.template` | TLS·HTTP→HTTPS·프록시 (`${DOMAIN}` 자동 치환) |

> CLAUDE.md 7단계에는 Jenkins 로 적혀 있지만, Phase 1 결정(D1)에 따라 **GitHub Actions** 를 쓴다. 별도 CI 서버를 운영하지 않아도 되고 PR 체크와 바로 연결된다.

## 1. 준비물

| 항목 | 메모 |
|---|---|
| GitHub 계정·저장소 | 공개 저장소면 Actions·환경 승인 무료. 비공개면 월 무료 실행 시간 안에서, **환경 승인(Required reviewers)은 유료 플랜에서만** 가능 |
| AWS 계정 | 무료 혜택은 가입 시점부터 흐르므로 **배포 직전에 가입** (2025-07-15 이후 가입은 크레딧 기반 최대 6개월) |
| 도메인 | 없으면 [DuckDNS](https://www.duckdns.org) 무료 서브도메인. HTTPS 가 있어야 로그인 쿠키(Secure)와 원격 MCP 가 동작 |

## 2. 저장소 만들고 올리기

```bash
cd game-admin
git init -b main
git add .
git status          # .env, node_modules, *-output.txt 가 목록에 없는지 확인 (.gitignore)
git commit -m "게임 운영 백오피스 + MCP 서버"
# GitHub 에서 빈 저장소를 만든 뒤
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

- 푸시하면 **CI** 가 돈다 (Actions 탭). 통합 테스트는 러너의 Docker 로 MySQL·Redis 를 띄우므로 10분 안팎.
- main 이 통과하면 GHCR 에 이미지 4개가 올라간다 (저장소 → Packages). 태그 = 커밋 해시 앞 7자리, `latest`.
- 이후 작업은 브랜치 → PR → CI 통과 → main 머지 순서를 권장.

## 3. 서버(EC2) 준비

### 3.1 인스턴스

| 항목 | 값 |
|---|---|
| AMI | Ubuntu Server 24.04 LTS |
| 유형 | **t3.small (2GB)** 권장. t3.micro(1GB)도 되지만 swap 필수, 느림 |
| 디스크 | gp3 30GB |
| 보안 그룹 | 22: **내 IP 만** / 80, 443: 전체 |
| 키 페어 | 새로 생성 (내 PC 에서 서버 관리용) |

> 공인 IPv4 는 2024년부터 시간당 과금 대상이다. 탄력적 IP 를 붙이면 재시작해도 주소가 안 바뀐다 (DuckDNS 를 다시 고칠 필요 없음).

### 3.2 기본 설정 (SSH 접속 후)

```bash
# swap 2GB (메모리 부족으로 MySQL 이 죽는 것 방지)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker (공식 저장소)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # 다시 접속하면 sudo 없이 docker 사용

# 배포 폴더
sudo mkdir -p /opt/game-admin && sudo chown ubuntu:ubuntu /opt/game-admin
```

### 3.3 `.env`

내 PC 에서 양식을 복사해 값을 채운 뒤 서버로 올린다. **저장소에는 올리지 않는다.**

```bash
cp deploy/.env.prod.example .env.prod       # 값 채우기 (DOMAIN, MySQL 비밀번호, JWT_ACCESS_SECRET, SEED_ADMIN_PASSWORD)
scp -i <키.pem> .env.prod ubuntu@<서버>:/opt/game-admin/.env
ssh -i <키.pem> ubuntu@<서버> 'chmod 600 /opt/game-admin/.env'
rm .env.prod
```

## 4. 도메인과 첫 인증서

1. DuckDNS 에서 서브도메인을 만들고 IP 를 EC2 공인 IP(탄력적 IP)로 설정 → `DOMAIN` 에 같은 값.
2. 첫 인증서는 Nginx 가 뜨기 전에 한 번만 standalone 으로 받는다 (80 포트가 비어 있을 때):

```bash
# 서버에서
docker volume create game-admin_letsencrypt
docker run --rm -p 80:80 -v game-admin_letsencrypt:/etc/letsencrypt certbot/certbot \
  certonly --standalone -d <도메인> -m <이메일> --agree-tos -n
```

이후 갱신은 `certbot` 컨테이너가 12시간마다 확인하고, Nginx 가 6시간마다 다시 읽는다.

## 5. GitHub 설정 (배포용)

### 5.1 배포 전용 SSH 키

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-actions-deploy"
ssh-copy-id -i deploy_key.pub -o IdentityFile=<키.pem> ubuntu@<서버>   # 또는 authorized_keys 에 직접 추가
ssh-keyscan -t ed25519 <서버> > known_hosts.txt   # 지문을 EC2 콘솔(인스턴스 → 작업 → 시스템 로그)과 비교
```

### 5.2 저장소 비밀값 (Settings → Secrets and variables → Actions)

| 이름 | 값 |
|---|---|
| `DEPLOY_HOST` | 서버 주소 (도메인 또는 IP) |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | `deploy_key` (개인키) 내용 전체 |
| `DEPLOY_KNOWN_HOSTS` | `known_hosts.txt` 내용 |

다 넣었으면 내 PC 의 `deploy_key` 는 지운다. GHCR 로그인은 배포 작업 동안만 유효한 `GITHUB_TOKEN` 을 쓰므로 서버에 영구 토큰을 두지 않는다.

### 5.3 환경 승인

Settings → Environments → `production` → Required reviewers 에 본인 추가 → 배포 버튼을 눌러도 승인해야 진행된다 (공개 저장소 또는 유료 플랜).

## 6. 배포

### 6.1 실행

Actions → **Deploy** → Run workflow → `tag` 에 배포할 커밋 해시 7자리 (CI 의 이미지 빌드가 끝난 커밋) → 승인.

서버의 `deploy.sh` 가 하는 일:

1. 새 태그 이미지 받기 (api·worker·web·mcp)
2. MySQL·Redis 가 준비될 때까지 대기
3. **마이그레이션** (`node dist/migrate.js`) — 실패하면 앱을 바꾸지 않고 중단
4. 앱 교체 (`up -d`)
5. `https://<도메인>/api/v1/health/ready` 를 최대 60초 확인
6. 실패하면 로그 50줄 출력 후 **이전 태그로 되돌림**, 성공하면 `.deployed-tag` 에 기록

### 6.2 첫 배포 후 한 번만

```bash
cd /opt/game-admin
export IMAGE_PREFIX=ghcr.io/<owner>/<repo> IMAGE_TAG=$(cat .deployed-tag)
# 역할·권한·재화·운영자 4명
docker compose -f docker-compose.prod.yml run --rm api node dist/seed.js
# (데모용) 가상 회원·활동 데이터 — 운영 데이터가 아님을 확인하고 실행
docker compose -f docker-compose.prod.yml run --rm -e NODE_ENV=development api node dist/seed-game.js --scale=small
```

- 끝나면 `.env` 에서 `SEED_ADMIN_PASSWORD` 를 지우고, 시드 운영자로 로그인해 **비밀번호를 바로 바꾼다**.
- 가상 데이터 시드는 production 에서 막혀 있어 이 한 번만 `NODE_ENV=development` 로 실행한다. 실제 게임 데이터는 쓰지 않는다 (CLAUDE.md 보안 원칙).

### 6.3 확인

- 백오피스: `https://<도메인>`
- MCP: 웹에서 API 토큰 발급 → `claude mcp add --transport http game-admin https://<도메인>/mcp --header "Authorization: Bearer <토큰>"`

## 7. 되돌리기

- Actions → Deploy 에 **이전 태그**를 넣어 다시 배포 (서버 `.deployed-tag` 이력이나 GHCR 태그 목록 참고).
- 마이그레이션은 앞으로만 진행된다. 컬럼 삭제처럼 이전 코드와 호환되지 않는 변경은 "코드에서 먼저 안 쓰게 배포 → 다음 배포에서 스키마 변경" 두 단계로 나눈다.

## 8. 백업

```bash
# 매일 03:30 UTC, 7일 보관 (crontab -e)
30 3 * * * cd /opt/game-admin && mkdir -p backups && \
  docker compose -f docker-compose.prod.yml exec -T mysql sh -c 'mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --single-transaction --routines "$MYSQL_DATABASE"' \
  | gzip > backups/db-$(date +\%F).sql.gz && find backups -name 'db-*.sql.gz' -mtime +7 -delete
```

복원: `gunzip -c backups/db-<날짜>.sql.gz | docker compose -f docker-compose.prod.yml exec -T mysql sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'`

업로드 이미지는 `game-admin_uploads` 볼륨에 있다. 서버를 없앨 때는 S3 등으로 옮기거나 함께 백업한다.

## 9. 자주 쓰는 명령 (서버)

```bash
cd /opt/game-admin
export IMAGE_PREFIX=ghcr.io/<owner>/<repo> IMAGE_TAG=$(cat .deployed-tag)
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f --tail=100 api worker
docker compose -f docker-compose.prod.yml restart api
free -h && df -h
```

## 10. 보안 점검

- [ ] 보안 그룹 22번은 내 IP 만, DB·Redis·API·MCP 포트는 외부에 없음 (Compose 에 `ports` 는 web 의 80·443 뿐)
- [ ] `.env` 권한 600, 저장소·이미지에 비밀값 없음 (`.dockerignore` 가 `.env*` 제외)
- [ ] HTTPS 강제(HTTP → 301), HSTS, 쿠키 Secure (production 기본값)
- [ ] 시뮬레이터 내부 API 는 production 에서 등록되지 않음 (`INTERNAL_API_KEY` 없음)
- [ ] MCP 는 허용 Host = 도메인만, API 토큰만 허용
- [ ] 시드 비밀번호 제거, 운영자 비밀번호 변경
- [ ] 배포 SSH 키는 배포 전용, GitHub 비밀값에만 보관

## 11. 비용과 정리

- 무료 혜택(크레딧)이 끝나면 EC2·공인 IPv4·EBS 가 과금된다. 포트폴리오 시연이 끝나면 인스턴스 **종료(terminate)** 와 탄력적 IP **해제**, EBS 스냅샷 삭제까지 확인한다.
- GHCR 이미지는 저장소 Packages 에서 오래된 태그를 지운다.
