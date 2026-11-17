import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  AuditAction,
  AuditTargetType,
  ErrorCode,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  type AssetView,
} from '@game-admin/shared';
import { BusinessRuleError, NotFoundError } from '../../common/errors/app-error.js';
import type { Executor } from '../../infra/db/types.js';
import { assets } from '../../infra/db/schema/index.js';
import type { AssetStorage } from '../../infra/storage/asset-storage.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import { sniffImage } from './image-sniff.js';

type AssetRow = typeof assets.$inferSelect;

/** 공개 주소 — 게임 클라이언트도 받아야 하므로 인증 없음 (키는 추측 불가 UUID) */
export const assetUrl = (key: string) => `/api/v1/public/assets/${key}`;

export const assetView = (r: AssetRow): AssetView => ({
  id: r.id,
  url: assetUrl(r.storageKey),
  mime: r.mime,
  width: r.width,
  height: r.height,
  size: r.size,
});

export function createAssetService(deps: { db: Executor; storage: AssetStorage }) {
  const { db, storage } = deps;

  return {
    /**
     * 이미지 업로드
     * 1) 크기 2) 매직 바이트로 형식 판별(PNG·JPEG·WebP, SVG 불가) 3) 가로·세로 상한
     * 같은 파일(sha256)이 이미 있으면 그걸 돌려준다 (중복 저장 방지)
     */
    async upload(data: Buffer, originalName: string, audit: AuditContext): Promise<AssetView> {
      if (!data.length) throw new BusinessRuleError(ErrorCode.INVALID_IMAGE, '빈 파일입니다.');
      if (data.length > IMAGE_MAX_BYTES) {
        throw new BusinessRuleError(
          ErrorCode.INVALID_IMAGE,
          `이미지는 ${IMAGE_MAX_BYTES / 1024 / 1024}MB 까지 올릴 수 있습니다.`,
        );
      }
      const img = sniffImage(data);
      if (!img)
        throw new BusinessRuleError(
          ErrorCode.INVALID_IMAGE,
          'PNG·JPEG·WebP 이미지만 올릴 수 있습니다.',
        );
      if (img.width > IMAGE_MAX_PIXELS || img.height > IMAGE_MAX_PIXELS) {
        throw new BusinessRuleError(
          ErrorCode.INVALID_IMAGE,
          `이미지는 가로·세로 ${IMAGE_MAX_PIXELS}px 까지입니다. (현재 ${img.width}×${img.height})`,
        );
      }

      const sha256 = createHash('sha256').update(data).digest('hex');
      const [dup] = await db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
      if (dup) return assetView(dup);

      const storageKey = `${randomUUID()}.${img.ext}`;
      await storage.put(storageKey, data);
      // 제어 문자 제거 (로그·화면 표시용 이름)
      const name =
        [...originalName]
          .filter((c) => c.charCodeAt(0) >= 32)
          .join('')
          .slice(0, 200) || 'image';
      const [created] = await db
        .insert(assets)
        .values({
          storageKey,
          mime: img.mime,
          size: data.length,
          width: img.width,
          height: img.height,
          sha256,
          originalName: name,
          createdBy: audit.adminId!,
        })
        .$returningId();
      await writeAudit(db, audit, {
        action: AuditAction.ASSET_UPLOAD,
        targetType: AuditTargetType.ASSET,
        targetId: created!.id,
        after: {
          originalName: name,
          mime: img.mime,
          size: data.length,
          width: img.width,
          height: img.height,
        },
      });
      const [row] = await db.select().from(assets).where(eq(assets.id, created!.id));
      return assetView(row!);
    },

    async get(id: number): Promise<AssetView> {
      const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
      if (!row) throw new NotFoundError(ErrorCode.ASSET_NOT_FOUND, '이미지를 찾을 수 없습니다.');
      return assetView(row);
    },

    async views(ids: number[]): Promise<Map<number, AssetView>> {
      if (!ids.length) return new Map();
      const rows = await db
        .select()
        .from(assets)
        .where(inArray(assets.id, [...new Set(ids)]));
      return new Map(rows.map((r) => [r.id, assetView(r)]));
    },

    /** 공개 제공: 키로 파일과 판별된 형식을 찾는다 */
    async file(storageKey: string): Promise<{ mime: string; data: Buffer } | null> {
      const [row] = await db
        .select({ mime: assets.mime })
        .from(assets)
        .where(eq(assets.storageKey, storageKey))
        .limit(1);
      if (!row) return null;
      const data = await storage.get(storageKey);
      return data ? { mime: row.mime, data } : null;
    },

    async exists(id: number) {
      const [row] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, id))
        .limit(1);
      return !!row;
    },
  };
}

export type AssetService = ReturnType<typeof createAssetService>;
