import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  idParamSchema,
  Permission,
  publicIdSchema,
  rankingManageRequestSchema,
  rankingQuerySchema,
  rankingRestoreRequestSchema,
  rankingRewardRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Idempotency } from '../safety/idempotency.js';
import type { RankingService } from './ranking.service.js';

export function rankingsRouter(deps: {
  rankingService: RankingService;
  idempotency: Idempotency;
  authenticate: RequestHandler;
}): Router {
  const { rankingService, idempotency, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.RANKING_READ)];
  const manage = [authenticate, requirePermission(Permission.RANKING_MANAGE)];
  const season = (v: unknown) => idParamSchema.parse(v);

  // 랭킹 종류 목록 — 스케줄(시즌 만들기)·랭킹 화면 공용, 민감 정보 아님 → 로그인만
  router.get('/ranking-boards', authenticate, requirePermission(), async (_req, res) => {
    res.json({ data: await rankingService.boards() });
  });

  router.get('/ranking-seasons', ...read, async (_req, res) => {
    res.json({ data: await rankingService.seasons() });
  });

  router.get('/ranking-seasons/:seasonId/rankings', ...read, async (req, res) => {
    const { offset, limit } = rankingQuerySchema.parse(req.query);
    const {
      season: s,
      entries,
      total,
    } = await rankingService.ranking(season(req.params.seasonId), offset, limit);
    res.json({ data: { season: s, entries }, meta: { offset, limit, total } });
  });

  router.get('/ranking-seasons/:seasonId/rankings/users/:publicId', ...read, async (req, res) => {
    res.json({
      data: await rankingService.userRank(
        season(req.params.seasonId),
        publicIdSchema.parse(req.params.publicId),
      ),
    });
  });

  router.get('/ranking-seasons/:seasonId/snapshots', ...read, async (req, res) => {
    res.json({ data: await rankingService.snapshots(season(req.params.seasonId)) });
  });

  router.get('/ranking-seasons/:seasonId/snapshots/:snapshotId', ...read, async (req, res) => {
    const { offset, limit } = rankingQuerySchema.parse(req.query);
    const snapshotId = z.string().uuid().parse(req.params.snapshotId);
    res.json({
      data: await rankingService.snapshot(season(req.params.seasonId), snapshotId, offset, limit),
    });
  });

  router.post('/ranking-seasons/:seasonId/rebuild', ...manage, async (req, res) => {
    const seasonId = season(req.params.seasonId);
    const { reason } = rankingManageRequestSchema.parse(req.body);
    await idempotency.run(req, res, { seasonId, reason, op: 'rebuild' }, async (record) => {
      const result = await rankingService.rebuild(seasonId, reason, auditContextOf(req), (tx, r) =>
        record(tx, 200, { data: r }),
      );
      return { status: 200, body: { data: result } };
    });
  });

  // 초기화 (L3): 빨간 경고 확인 후 실행, 웹에서만
  router.post('/ranking-seasons/:seasonId/reset', ...manage, async (req, res) => {
    const seasonId = season(req.params.seasonId);
    const input = rankingManageRequestSchema.parse(req.body);
    await idempotency.run(req, res, { seasonId, ...input, op: 'reset' }, async (record) => {
      const result = await rankingService.reset(
        req.auth!,
        seasonId,
        input,
        auditContextOf(req),
        (tx, r) => record(tx, 200, { data: r }),
      );
      return { status: 200, body: { data: result } };
    });
  });

  // 스냅샷 복원 (L3): 현재 순위를 스냅샷으로 교체, 직전 상태는 자동 보관
  router.post('/ranking-seasons/:seasonId/restore', ...manage, async (req, res) => {
    const seasonId = season(req.params.seasonId);
    const input = rankingRestoreRequestSchema.parse(req.body);
    await idempotency.run(req, res, { seasonId, ...input, op: 'restore' }, async (record) => {
      const result = await rankingService.restore(
        req.auth!,
        seasonId,
        input,
        auditContextOf(req),
        (tx, r) => record(tx, 200, { data: r }),
      );
      return { status: 200, body: { data: result } };
    });
  });

  // 스냅샷 순위 보상 우편 (L3, 스냅샷당 1회)
  router.post('/ranking-seasons/:seasonId/rewards', ...manage, async (req, res) => {
    const seasonId = season(req.params.seasonId);
    const input = rankingRewardRequestSchema.parse(req.body);
    await idempotency.run(req, res, { seasonId, ...input, op: 'reward' }, async (record) => {
      const result = await rankingService.reward(
        req.auth!,
        seasonId,
        input,
        auditContextOf(req),
        (tx, r) => record(tx, 201, { data: r }),
      );
      return { status: 201, body: { data: result } };
    });
  });

  // 스냅샷 CSV 내보내기 — 엑셀 호환(UTF-8 BOM), 수식 주입 방지, 운영 로그 기록
  router.get(
    '/ranking-seasons/:seasonId/snapshots/:snapshotId/export',
    ...read,
    async (req, res) => {
      const seasonId = season(req.params.seasonId);
      const snapshotId = z.string().uuid().parse(req.params.snapshotId);
      const rows = rankingService.snapshotRows(seasonId, snapshotId);
      // 첫 묶음을 먼저 받아 스냅샷이 없으면 404 를 JSON 으로 돌려줄 수 있게 함
      const first = await rows.next();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="ranking-season${seasonId}-${snapshotId.slice(0, 8)}.csv"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.write('\uFEFF순위,회원ID,닉네임,점수\r\n');
      let count = 0;
      const writeBatch = (
        batch: { rank: number; publicId: string | null; nickname: string | null; score: number }[],
      ) => {
        res.write(
          batch
            .map((r) =>
              [r.rank, csvCell(r.publicId ?? ''), csvCell(r.nickname ?? '(탈퇴)'), r.score].join(
                ',',
              ),
            )
            .join('\r\n') + '\r\n',
        );
        count += batch.length;
      };
      if (!first.done) writeBatch(first.value);
      for await (const batch of rows) writeBatch(batch);
      res.end();
      await rankingService.recordExport(seasonId, snapshotId, count, auditContextOf(req));
    },
  );

  return router;
}

/**
 * CSV 칸 이스케이프
 * - 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감쌈
 * - = + - @ 탭 CR 로 시작하면 앞에 ' 를 붙여 엑셀 수식 실행(CSV injection)을 막음 (닉네임은 회원이 정하는 값)
 */
export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
