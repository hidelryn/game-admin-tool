import { randomBytes } from 'node:crypto';
import { Channel, ErrorCode, type ConfirmationRequiredDetails } from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import {
  AppError,
  BusinessRuleError,
  ServiceUnavailableError,
} from '../../common/errors/app-error.js';
import { hashPayload } from '../../common/http/stable-hash.js';
import type { RedisHandle } from '../../infra/redis/client.js';

const TTL_SEC = 300;

interface Binding {
  adminId: number;
  action: string;
  hash: string;
}

/**
 * 위험 작업(L2) 확인 토큰 (architecture.md 4.4)
 * - 1차 호출: 실행하지 않고 미리보기 + 토큰 발급 (요청 내용 해시에 바인딩, 5분, 1회용)
 * - 2차 호출: 같은 내용 + 토큰 → 실행. 내용이 바뀌면 거부 (확인 후 수량 바꿔치기 방지)
 * - Redis 장애 시 위험 작업은 실행하지 않는다 (fail-closed)
 * - webOnly(L3): 웹 밖(MCP)에서는 미리보기만 돌려주고 실행 불가
 */
export function createConfirmation(deps: { redis: RedisHandle; logger: Logger }) {
  const { redis, logger } = deps;
  const key = (token: string) => `confirm:${token}`;

  function unavailable(err: unknown) {
    logger.error({ err: (err as Error).message }, 'confirmation store unavailable');
    return new ServiceUnavailableError(
      ErrorCode.SERVICE_UNAVAILABLE,
      '확인 절차를 진행할 수 없어 위험 작업을 중단했습니다.',
    );
  }

  return {
    /**
     * 토큰이 없으면 발급 후 CONFIRMATION_REQUIRED 를 던지고, 있으면 검증·소비한다.
     * @param payload 확인 대상 요청 내용 (confirmationToken 제외)
     */
    async require<TPreview>(opts: {
      adminId: number;
      action: string;
      payload: unknown;
      token: string | undefined;
      preview: () => Promise<TPreview> | TPreview;
      /**
       * L3(대규모·되돌리기 어려운 작업): 웹에서 사람만 실행.
       * 다른 경로(MCP 토큰)는 토큰을 발급하지 않고 미리보기만 담아 403 CHANNEL_NOT_ALLOWED
       */
      webOnly?: { channel: Channel };
    }): Promise<void> {
      if (opts.webOnly && opts.webOnly.channel !== Channel.WEB) {
        throw new AppError(
          403,
          ErrorCode.CHANNEL_NOT_ALLOWED,
          '대규모 작업이라 웹 백오피스에서 사람이 확인 후 실행해야 합니다. 아래 미리보기를 운영자에게 전달하세요.',
          { preview: await opts.preview() },
        );
      }
      const hash = hashPayload(opts.payload);

      if (!opts.token) {
        const token = `cf_${randomBytes(24).toString('base64url')}`;
        const binding: Binding = { adminId: opts.adminId, action: opts.action, hash };
        try {
          await redis.redis.set(key(token), JSON.stringify(binding), 'EX', TTL_SEC);
        } catch (err) {
          throw unavailable(err);
        }
        const details: ConfirmationRequiredDetails<TPreview> = {
          preview: await opts.preview(),
          confirmationToken: token,
          expiresAt: new Date(Date.now() + TTL_SEC * 1000).toISOString(),
        };
        throw new BusinessRuleError(
          ErrorCode.CONFIRMATION_REQUIRED,
          '아직 실행되지 않았습니다. 미리보기를 확인한 뒤 confirmationToken 을 넣어 다시 요청하세요.',
          details,
        );
      }

      let raw: string | null;
      try {
        // 1회용: 꺼내면서 삭제
        raw = await redis.redis.getdel(key(opts.token));
      } catch (err) {
        throw unavailable(err);
      }
      const binding = raw ? (JSON.parse(raw) as Binding) : null;
      if (
        !binding ||
        binding.adminId !== opts.adminId ||
        binding.action !== opts.action ||
        binding.hash !== hash
      ) {
        throw new BusinessRuleError(
          ErrorCode.CONFIRMATION_MISMATCH,
          '확인 토큰이 만료되었거나 요청 내용과 일치하지 않습니다. 다시 확인을 진행하세요.',
        );
      }
    },
  };
}

export type Confirmation = ReturnType<typeof createConfirmation>;
