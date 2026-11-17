/**
 * 게임 서버 시뮬레이터: npm run simulate -- [--users=50] [--interval=5] [--ticks=0]
 *
 * 실제 게임 서버처럼 내부 API(/api/v1/internal/game/*)만 호출한다 → DB 에 직접 쓰지 않음.
 * 매 틱마다 활동 회원을 뽑아 로그인·스테이지 클리어·재화 획득/소비·점수 기록·우편 수령을 발생시킨다.
 * 대시보드(DAU·재화 흐름), 회원 활동 이력, 랭킹, 우편 수령 현황이 살아 움직이게 하는 용도.
 *
 * 필요: API 서버 실행 중 + .env 의 INTERNAL_API_KEY (production 에서는 내부 API 가 꺼져 있어 동작하지 않음)
 */
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);
const API =
  (process.env.SIMULATOR_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`) +
  '/api/v1/internal/game';
const KEY = process.env.INTERNAL_API_KEY;
const USERS = Number(args.get('users') ?? 50);
const INTERVAL_SEC = Number(args.get('interval') ?? 5);
const TICKS = Number(args.get('ticks') ?? 0); // 0 = 무한

if (!KEY) {
  console.error(
    '[simulator] .env 에 INTERNAL_API_KEY (32자 이상) 를 설정하고 API 서버를 재시작하세요.',
  );
  process.exit(1);
}

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const chance = (p: number) => Math.random() < p;

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data?: T; code?: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY! },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string } };
  return { ok: res.ok, status: res.status, data: json.data, code: json.error?.code };
}

interface MailboxItem {
  mailId: number;
  status: string;
  expiresAt: string;
  claimedAt: string | null;
}

interface LiveOps {
  seasons: { id: number; boardCode: string; boardName: string; name: string; endsAt: string }[];
  events: { id: number; title: string }[];
  popups: { id: number; title: string; frequency: string }[];
  banners: { id: number; title: string; priority: number }[];
  maintenance: { active: boolean; title: string | null; endsAt: string | null };
  sessionEpoch: number;
  tickers: { noticeId: number; text: string }[];
}

/** 직전 틱의 노출 상태 — 바뀔 때만 로그 (스케줄 화면에서 바꾼 게 게임에 반영되는지 확인용) */
let lastLiveOps = '';
/** 접속 중 유저들의 세션 세대 — live-ops 의 세대가 올라가면 "모든 세션 종료" (docs/maintenance-notice.md 2장) */
let sessionEpoch: number | null = null;
let inMaintenance = false;

const maintenanceLog = (endsAt: string | null) =>
  console.warn(`[simulator] 점검 중 (~${endsAt?.slice(0, 16) ?? '?'}) — 이번 틱 플레이 중단`);

async function tick(n: number) {
  // 게임이 접속할 때마다 받는 "지금 보여줄 것" (docs/schedule.md 7장)
  const live = await call<LiveOps>('GET', '/live-ops');
  const ops = live.data;
  if (ops) {
    const summary = [
      `시즌: ${ops.seasons.map((x) => `${x.boardName}/${x.name}(~${x.endsAt.slice(0, 16)})`).join(', ') || '없음'}`,
      `이벤트: ${ops.events.map((e) => e.title).join(', ') || '없음'}`,
      `팝업: ${ops.popups.map((p) => `${p.title}[${p.frequency}]`).join(', ') || '없음'}`,
      `배너: ${ops.banners.map((b) => b.title).join(' > ') || '없음'}`,
      `티커: ${ops.tickers.map((t) => t.text).join(' / ') || '없음'}`,
    ].join(' | ');
    if (summary !== lastLiveOps) {
      console.warn(`[simulator] 라이브 운영 ${summary}`);
      lastLiveOps = summary;
    }
  }
  if (ops) {
    if (sessionEpoch !== null && ops.sessionEpoch > sessionEpoch) {
      console.warn(
        `[simulator] 세션 종료 — 세대 ${sessionEpoch} → ${ops.sessionEpoch}, 접속 중인 모든 유저 연결을 끊었습니다`,
      );
    }
    sessionEpoch = ops.sessionEpoch;
    if (ops.maintenance.active) {
      // 게임 서버는 로그인 화면에 점검 안내만 보여주고 플레이를 받지 않는다
      if (!inMaintenance) maintenanceLog(ops.maintenance.endsAt);
      inMaintenance = true;
      return;
    }
    if (inMaintenance) console.warn('[simulator] 점검 종료 — 접속 재개');
    inMaintenance = false;
  }
  // 진행 중인 랭킹(보드)들 — 점수는 그중 하나에 무작위로 기록
  const boards = ops?.seasons.map((x) => x.boardCode) ?? [];

  const sample = await call<string[]>('GET', `/users/sample?size=${USERS}`);
  if (!sample.ok) throw new Error(`sample failed: ${sample.status} ${sample.code ?? ''}`);
  const ids = sample.data ?? [];
  const stats = {
    logins: 0,
    clears: 0,
    earned: 0,
    spent: 0,
    insufficient: 0,
    scores: 0,
    claims: 0,
  };

  // 1) 활동 이벤트 (한 번에 전송)
  const now = Date.now();
  const events = ids.flatMap((publicId) => {
    const list: {
      publicId: string;
      type: string;
      payload?: Record<string, unknown>;
      occurredAt: string;
    }[] = [{ publicId, type: 'LOGIN', occurredAt: new Date(now).toISOString() }];
    for (let i = 0; i < rand(0, 3); i++) {
      list.push({
        publicId,
        type: 'STAGE_CLEAR',
        payload: { stage: rand(1, 120), stars: rand(1, 3) },
        occurredAt: new Date(now + (i + 1) * 1000).toISOString(),
      });
    }
    return list;
  });
  for (let i = 0; i < events.length; i += 500) {
    const r = await call<{ accepted: number }>('POST', '/events', {
      events: events.slice(i, i + 500),
    });
    if (r.status === 503 && r.code === 'MAINTENANCE') {
      // 틱 도중 점검이 시작됨
      maintenanceLog(null);
      inMaintenance = true;
      return;
    }
    stats.logins += events.slice(i, i + 500).filter((e) => e.type === 'LOGIN').length;
    stats.clears +=
      (r.data?.accepted ?? 0) - events.slice(i, i + 500).filter((e) => e.type === 'LOGIN').length;
  }

  // 2) 회원별 재화·점수·우편 (동시 10명씩)
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map(async (publicId) => {
        const gold = await call('POST', '/currencies', {
          publicId,
          currencyCode: 'GOLD',
          delta: rand(100, 2_000),
          reason: '스테이지 클리어 보상',
        });
        if (gold.ok) stats.earned++;
        if (chance(0.15)) {
          const fg = await call('POST', '/currencies', {
            publicId,
            currencyCode: 'FREE_GEM',
            delta: rand(5, 30),
            reason: '일일 미션 보상',
          });
          if (fg.ok) stats.earned++;
        }
        if (chance(0.4)) {
          const spend = await call('POST', '/currencies', {
            publicId,
            currencyCode: chance(0.5) ? 'GOLD' : 'STAMINA',
            delta: -rand(10, 500),
            reason: chance(0.5) ? '장비 강화' : '스테이지 입장',
          });
          if (spend.ok) stats.spent++;
          else if (spend.code === 'INSUFFICIENT_BALANCE') stats.insufficient++;
        }
        // 진행 중 시즌이 있을 때만 점수 기록 (시즌 종료 후엔 서버도 거부)
        if (boards.length && chance(0.3)) {
          const s = await call('POST', '/scores', {
            boardCode: boards[rand(0, boards.length - 1)],
            publicId,
            score: rand(1_000, 60_000) + n * 50,
          });
          if (s.ok) stats.scores++;
        }
        if (chance(0.5)) {
          const box = await call<MailboxItem[]>('GET', `/users/${publicId}/mails`);
          const claimable = (box.data ?? []).filter(
            (m) => m.status === 'SENT' && !m.claimedAt && new Date(m.expiresAt) > new Date(),
          );
          for (const m of claimable.slice(0, 3)) {
            const c = await call('POST', `/mails/${m.mailId}/claim`, { publicId });
            if (c.ok) stats.claims++;
          }
        }
      }),
    );
  }
  console.warn(`[simulator] tick ${n} — users ${ids.length}, ${JSON.stringify(stats)}`);
}

console.warn(
  `[simulator] ${API} — ${USERS}명/틱, ${INTERVAL_SEC}초 간격${TICKS ? `, ${TICKS}틱` : ''} (Ctrl+C 로 종료)`,
);
let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
});
for (let n = 1; !stopped && (TICKS === 0 || n <= TICKS); n++) {
  try {
    await tick(n);
  } catch (err) {
    console.error(`[simulator] tick ${n} 실패: ${(err as Error).message}`);
  }
  if (TICKS === 0 || n < TICKS) await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
}

export {};
