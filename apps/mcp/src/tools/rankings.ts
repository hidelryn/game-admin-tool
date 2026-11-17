import { z } from 'zod';
import {
  Permission,
  type RankingEntry,
  type RankingSeasonView,
  type RankingSnapshotSummary,
  type UserRankView,
} from '@game-admin/shared';
import { seg, type ApiClient } from '../api-client.js';
import { ToolInputError, allOf, defineTool, num, ok, publicId, q } from './define.js';

const boardCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{2,20}$/)
  .describe('랭킹 종류 코드 (ARENA = 아레나, WORLD_ARENA = 월드아레나)');

const seasonView = (s: RankingSeasonView) => ({
  id: s.id,
  board: { code: s.board.code, name: s.board.name },
  name: s.name,
  status: s.status,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
});

const entryView = (e: RankingEntry) => ({
  rank: e.rank,
  publicId: e.publicId,
  nickname: e.nickname,
  score: e.score,
});

async function seasonsOf(api: ApiClient, board?: string) {
  const all = (await api.get<RankingSeasonView[]>('/ranking-seasons')).data;
  return board ? all.filter((s) => s.board.code === board) : all;
}

export const getRanking = defineTool({
  name: 'get_ranking',
  title: '랭킹 조회',
  description:
    '랭킹 순위를 조회합니다. 시즌을 안 정하면 그 랭킹 종류(기본 ARENA)의 진행 중 시즌. publicId 를 넣으면 그 회원의 순위와 위·아래 5명.',
  input: {
    boardCode: boardCode.default('ARENA'),
    seasonId: z.number().int().positive().optional(),
    publicId: publicId.optional(),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.RANKING_READ),
  async run(a, { api }) {
    let seasonId = a.seasonId;
    if (!seasonId) {
      const seasons = await seasonsOf(api, a.boardCode);
      const active = seasons.find((s) => s.status === 'ACTIVE');
      if (!active) {
        throw new ToolInputError(
          'SEASON_NOT_ACTIVE',
          `${a.boardCode} 랭킹에 진행 중인 시즌이 없습니다. seasonId 로 지난 시즌을 지정하세요.`,
          { seasons: seasons.slice(-5).map(seasonView) },
        );
      }
      seasonId = active.id;
    }

    if (a.publicId) {
      const { data } = await api.get<UserRankView>(
        `/ranking-seasons/${seg(seasonId)}/rankings/users/${seg(a.publicId)}`,
      );
      return ok(
        data.me
          ? `${data.season.name}: ${a.publicId}(${q(data.me.nickname)}) ${num(data.me.rank)}위 · ${num(data.me.score)}점`
          : `${data.season.name}: ${a.publicId} 은(는) 순위에 없습니다.`,
        {
          season: seasonView(data.season),
          me: data.me ? entryView(data.me) : null,
          neighbors: data.neighbors.map(entryView),
        },
      );
    }

    const res = await api.get<{ season: RankingSeasonView; entries: RankingEntry[] }>(
      `/ranking-seasons/${seg(seasonId)}/rankings`,
      { offset: a.offset, limit: a.limit },
    );
    const entries = res.data.entries.map(entryView);
    const total = Number(res.meta?.total ?? entries.length);
    return ok(
      `${res.data.season.board.name} ${res.data.season.name} (${num(total)}명): ` +
        (entries
          .slice(0, 5)
          .map((e) => `${e.rank}위 ${q(e.nickname)} ${num(e.score)}`)
          .join(', ') || '기록 없음'),
      { season: seasonView(res.data.season), entries, total, offset: a.offset },
    );
  },
});

export const listRankingSeasons = defineTool({
  name: 'list_ranking_seasons',
  title: '랭킹 시즌·스냅샷 목록',
  description:
    '랭킹 시즌 목록(예정·진행·종료)을 조회합니다. seasonId 를 넣으면 그 시즌의 스냅샷(초기화 직전·복원 전 보관·시즌 최종)과 순위 보상 지급 여부. 초기화·복원·보상 실행은 웹에서만 할 수 있습니다.',
  input: {
    boardCode: boardCode.optional(),
    seasonId: z.number().int().positive().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.RANKING_READ),
  async run(a, { api }) {
    if (a.seasonId) {
      const { data } = await api.get<RankingSnapshotSummary[]>(
        `/ranking-seasons/${seg(a.seasonId)}/snapshots`,
      );
      const snapshots = data.map((s) => ({
        snapshotId: s.snapshotId,
        kind: s.kind,
        reason: s.reason,
        count: s.count,
        createdAt: s.createdAt,
        rewarded: !!s.payout,
        rewardRecipients: s.payout?.recipientCount ?? null,
      }));
      return ok(
        `시즌 #${a.seasonId} 스냅샷 ${snapshots.length}개` +
          (snapshots.length
            ? `: ${snapshots.map((s) => `${s.kind} ${s.createdAt.slice(0, 10)} ${num(s.count)}명${s.rewarded ? '(보상 지급)' : ''}`).join(', ')}`
            : ''),
        { seasonId: a.seasonId, snapshots },
      );
    }
    const seasons = (await seasonsOf(api, a.boardCode)).map(seasonView);
    return ok(
      seasons.map((s) => `#${s.id} [${s.board.name}] ${q(s.name)} ${s.status}`).join(', ') ||
        '시즌이 없습니다.',
      { seasons },
    );
  },
});
