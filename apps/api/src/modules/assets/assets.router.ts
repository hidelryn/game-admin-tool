import express, { Router, type RequestHandler } from 'express';
import { IMAGE_MAX_BYTES, idParamSchema, Permission } from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import { ASSET_KEY_PATTERN } from '../../infra/storage/asset-storage.js';
import type { AssetService } from './asset.service.js';

/**
 * 이미지 업로드·제공
 * - POST /assets : 본문 = 이미지 바이트 그대로 (멀티파트 불필요), 원래 이름은 X-File-Name(URL 인코딩)
 * - GET  /public/assets/:key : 인증 없음(게임에서도 사용). 판별된 형식으로만 응답
 */
export function assetsRouter(deps: {
  assetService: AssetService;
  authenticate: RequestHandler;
}): Router {
  const { assetService, authenticate } = deps;
  const router = Router();

  router.post(
    '/assets',
    authenticate,
    requirePermission(Permission.SCHEDULE_MANAGE),
    // 상한보다 조금 크게 받아 서비스에서 친절한 메시지로 거부 (그보다 크면 413)
    express.raw({ type: () => true, limit: IMAGE_MAX_BYTES + 1024 }),
    async (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let name = 'image';
      try {
        name = decodeURIComponent(req.header('x-file-name') ?? 'image');
      } catch {
        /* 잘못된 인코딩이면 기본 이름 */
      }
      res.status(201).json({ data: await assetService.upload(data, name, auditContextOf(req)) });
    },
  );

  router.get(
    '/assets/:id',
    authenticate,
    requirePermission(Permission.SCHEDULE_READ),
    async (req, res) => {
      res.json({ data: await assetService.get(idParamSchema.parse(req.params.id)) });
    },
  );

  router.get('/public/assets/:key', async (req, res) => {
    const key = String(req.params.key);
    const file = ASSET_KEY_PATTERN.test(key) ? await assetService.file(key) : null;
    if (!file) {
      res.status(404).end();
      return;
    }
    res.set({
      'Content-Type': file.mime,
      'Content-Length': String(file.data.length),
      // 내용 추측 금지 + 혹시 다른 내용이 섞여도 스크립트 실행 불가
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      // 게임 클라이언트(다른 출처)에서도 불러올 수 있게
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // 키가 내용마다 새로 만들어지므로 영구 캐시
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(file.data);
  });

  return router;
}
