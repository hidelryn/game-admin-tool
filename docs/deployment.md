# 배포 (Phase 7)

> 상태: **배포 완료** (2026-11-18). 아래 명령의 `<owner>/<repo>`, `<도메인>` 은 자리표시 — 실제 값은 0-1 표.

## 0-1. 현재 운영 값

| 항목 | 값 |
|---|---|
| 서비스 주소 | https://game-admin-delryn.duckdns.org |
| 저장소 / 이미지 | `hidelryn/game-admin-tool` / `ghcr.io/hidelryn/game-admin-tool/{api,worker,web,mcp}` |
| 서버 | AWS EC2 t3.small (Ubuntu 24.04, gp3 30GB, 탄력적 IP), **시드니(ap-southeast-2)** — 이유는 아래 기록 |
| 도메인 | DuckDNS 무료 서브도메인, 인증서 Let's Encrypt |
| 체험 모드 | 켜짐 (체험 계정 공개 · 매일 04:00 KST 초기화 · 5분마다 가상 활동) |
| 첫 배포 | 2026-11-18, 태그 `92072ff` |

### 실제 배포하며 생긴 일 (기록)

| 문제 | 원인 | 처리 |
|---|---|---|
| 오라클 프리티어 A1 생성 실패 | 2026년 무료 한도 축소(2 OCPU·12GB) + 도쿄 리전 용량 부족(out of capacity) | 재시도 스크립트를 만들었으나 빨리 띄우려고 AWS 로 전환 |
| AWS 에서 서울 리전 선택 불가 | 2026-09 새 가입 방식("Sign up for AWS (new)")은 프로젝트 리전을 연락처 국가 기준으로 자동 배정, 무료 플랜에선 변경 불가 | 시드니 사용 (한국에서 응답 0.1초대 추가, 데모엔 충분). 서울이 필요하면 유료 플랜 + 지출 한도 |
| Deploy 의 SSH 타임아웃 | 보안 그룹 22번을 "내 IP 만" 열어 GitHub Actions 러너가 못 들어옴 | 22번 전체 허용 (**키 전용 로그인 확인**). 실무 대안은 3.1 참고 |
| 하루(Live2D)가 안 보임 | Windows 에서 scp 로 올린 폴더 권한이 `drwx------` → nginx 가 못 읽고 index.html 로 대체 응답 → 브라우저가 그 HTML 을 캐시 | `chmod -R a+rX live2d`, nginx `/live2d/` 는 없으면 404 (index.html 대체 금지), 브라우저 캐시 삭제 |
| CI 첫 실패 | `.gitignore` 의 `storage/` 가 소스 폴더 `infra/storage` 까지 무시 | 업로드 폴더만 무시하도록 경로 고정 |

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
| AWS 계정 | 무료 혜택은 가입 시점부터 흐르므로 **배포 직전에 가입**. 2025-07-15 이후 가입은 크레딧($100 + 활동으로 최대 $100) 기반, Free 플랜은 최대 6개월 (t3.small 기준 월 약 $25 → $100 이면 약 4개월). **2026-09 새 가입 방식은 리전을 고를 수 없다** (연락처 국가 기준 자동 배정 — 한국은 시드니로 배정됨). 리전을 직접 고르려면 기존 방식(advanced)으로 가입 |
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
| 보안 그룹 | 80, 443: 전체 / 22: GitHub Actions 배포를 쓰면 **전체** (키 전용 로그인), 서버에서 직접 배포하면 내 IP 만 |
| 키 페어 | 새로 생성 (내 PC 에서 서버 관리용) |

> 공인 IPv4 는 2024년부터 시간당 과금 대상이다. 탄력적 IP 를 붙이면 재시작해도 주소가 안 바뀐다 (DuckDNS 를 다시 고칠 필요 없음).

> ⚠️ **22번 전체 허용에 대해**: GitHub 러너 IP 는 고정되지 않아 "내 IP 만" 으로는 Actions 배포가 타임아웃난다. Ubuntu EC2 는 기본으로 비밀번호 로그인이 꺼져 있어 키 없이는 들어올 수 없다 — `sudo sshd -T | grep -i passwordauthentication` 이 `no` 인지 확인.
> 실무에서는 22번을 인터넷에 열지 않는다: **AWS SSM Run Command + GitHub OIDC**(포트 없음, 장기 키 없음, 접속 기록), 서버가 이미지를 당겨 가는 pull 방식(ECS·Argo CD), 배스천·VPN 뒤 SSH, 내부망 self-hosted 러너 등. 이 프로젝트의 다음 개선 후보.

### 3.2 기본 설정 (SSH 접속 후)

```bash
# swap 2GB (메모리 부족으로 MySQL 이 죽는 것 방지)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker (공식 저장소)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # 다시 접속하면 sudo 없이 docker 사용

# 배포 폴더 (+ Live2D 모델 폴더)
sudo mkdir -p /opt/game-admin/live2d && sudo chown -R ubuntu:ubuntu /opt/game-admin
```

Windows 에서 SSH 키(.pem) 권한이 넓으면 접속이 거부된다:

```powershell
$key = "$env:USERPROFILE\.ssh\<키>.pem"
icacls $key /inheritance:r
icacls $key /grant:r "$($env:USERNAME):R"
ssh -i $key ubuntu@<서버>
```

### 3.3 `.env`

**권장: 서버에서 바로 생성** — 비밀값이 PC·채팅을 거치지 않는다. 출력된 `SEED_ADMIN_PASSWORD`(첫 로그인용)와 `DEMO_ACCOUNT_PASSWORD`(로그인 화면에 공개됨)만 기억해 둔다.

```bash
cd /opt/game-admin
umask 077
set -o noclobber   # 이미 있으면 덮어쓰지 않음
rnd() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-"$1"; }
cat > .env <<EOF
DOMAIN=<도메인>
MYSQL_DATABASE=game_admin
MYSQL_USER=game_admin
MYSQL_PASSWORD=$(rnd 32)
MYSQL_ROOT_PASSWORD=$(rnd 32)
JWT_ACCESS_SECRET=$(rnd 48)
SEED_ADMIN_PASSWORD=$(rnd 18)a1
LOG_LEVEL=info
DEMO_MODE=true
DEMO_ACCOUNT_EMAIL=demo@example.com
DEMO_ACCOUNT_PASSWORD=demo$(openssl rand -hex 4)26
DEMO_DAILY_RESET=true
DEMO_ACTIVITY_USERS=30
EOF
set +o noclobber
grep -E '^(SEED_ADMIN_PASSWORD|DEMO_ACCOUNT_PASSWORD)=' .env
```

또는 내 PC 에서 양식을 복사해 값을 채운 뒤 서버로 올린다. **저장소에는 올리지 않는다.**

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

서버에서 만들고, 서버 자신의 호스트 키로 known_hosts 줄을 만든다 (네트워크로 지문을 받지 않으니 중간자 걱정이 없다):

```bash
ssh-keygen -t ed25519 -f ~/deploy_key -N "" -C github-actions-deploy -q
cat ~/deploy_key.pub >> ~/.ssh/authorized_keys
cat ~/deploy_key                                                           # → DEPLOY_SSH_KEY
echo "<도메인> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"        # → DEPLOY_KNOWN_HOSTS
# GitHub 에 넣은 뒤
shred -u ~/deploy_key ~/deploy_key.pub
```

### 5.2 저장소 비밀값 (Settings → Secrets and variables → Actions)

| 이름 | 값 |
|---|---|
| `DEPLOY_HOST` | 서버 주소 (도메인 또는 IP) |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | `deploy_key` (개인키) 내용 전체 |
| `DEPLOY_KNOWN_HOSTS` | `known_hosts.txt` 내용 |

다 넣었으면 `deploy_key` 는 지운다. GHCR 로그인은 배포 작업 동안만 유효한 `GITHUB_TOKEN` 을 쓰므로 서버에 영구 토큰을 두지 않는다.

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
export IMAGE_PREFIX=ghcr.io/<owner>/<repo> IMAGE_TAG=$(cat .deployed-tag)   # owner/repo 는 소문자
# 역할·권한·재화·상품·운영자 4명(super·operator·cs·viewer @example.com)·체험 계정
docker compose -f docker-compose.prod.yml run --rm api node dist/seed.js
# (데모용) 가상 회원·활동 데이터 — 운영 데이터가 아님을 확인하고 실행
docker compose -f docker-compose.prod.yml run --rm -e NODE_ENV=development api node dist/seed-game.js --scale=small
```

- 시드 운영자 4명은 같은 초기 비밀번호다. `super@example.com` 으로 로그인해 **바로 바꾸고**, 안 쓰는 계정은 비활성화한다.
- 끝나면 `.env` 에서 지운다: `sed -i '/^SEED_ADMIN_PASSWORD=/d' /opt/game-admin/.env`
- 가상 데이터 시드는 production 에서 막혀 있어 이 한 번만 `NODE_ENV=development` 로 실행한다. 실제 게임 데이터는 쓰지 않는다 (CLAUDE.md 보안 원칙).

### 6.3 Live2D 모델 (git 에 없음 — docs/live2d.md)

```powershell
# 내 PC (전체 경로로)
scp -i <키.pem> -r <프로젝트>\apps\web\public\live2d\haru ubuntu@<서버>:/opt/game-admin/live2d/
```

```bash
# 서버 — Windows scp 는 폴더를 drwx------ 로 만들어 nginx 가 못 읽는다
chmod -R a+rX /opt/game-admin/live2d
```

### 6.4 확인

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

- [ ] 보안 그룹: DB·Redis·API·MCP 포트는 외부에 없음 (Compose 에 `ports` 는 web 의 80·443 뿐). 22번을 전체에 열었다면 비밀번호 로그인 꺼짐 확인
- [ ] `.env` 권한 600, 저장소·이미지에 비밀값 없음 (`.dockerignore` 가 `.env*` 제외)
- [ ] HTTPS 강제(HTTP → 301), HSTS, 쿠키 Secure (production 기본값)
- [ ] 시뮬레이터 내부 API 는 production 에서 등록되지 않음 (`INTERNAL_API_KEY` 없음)
- [ ] MCP 는 허용 Host = 도메인만, API 토큰만 허용
- [ ] 시드 비밀번호 제거, 운영자 비밀번호 변경
- [ ] 배포 SSH 키는 배포 전용, GitHub 비밀값에만 보관

## 11. 비용과 정리

- 무료 혜택(크레딧)이 끝나면 EC2·공인 IPv4·EBS 가 과금된다. 포트폴리오 시연이 끝나면 인스턴스 **종료(terminate)** 와 탄력적 IP **해제**, EBS 스냅샷 삭제까지 확인한다.
- GHCR 이미지는 저장소 Packages 에서 오래된 태그를 지운다.
