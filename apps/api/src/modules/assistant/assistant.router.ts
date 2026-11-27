import { Router, type RequestHandler } from 'express';
import { assistantChatRequestSchema, Permission, type AssistantEvent } from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { AssistantService } from './assistant.service.js';

/**
 * AI 어시스턴트 (docs/ai-assistant.md)
 * POST /assistant/chat 은 줄 단위 JSON(NDJSON)으로 진행 상황을 흘려보낸다.
 * 한도·권한 오류는 스트리밍 전에 일반 JSON 오류로 응답한다.
 */
export function assistantRouter(deps: {
  assistantService: AssistantService;
  authenticate: RequestHandler;
  /** 체험 계정 IP 당 하루 질문 수 */
  demoLimit: RequestHandler;
}): Router {
  const { assistantService, authenticate, demoLimit } = deps;
  const router = Router();
  const guard = [authenticate, requirePermission(Permission.ASSISTANT_USE)];

  router.get('/assistant/status', ...guard, (req, res) => {
    res.json({ data: assistantService.status(req.auth!) });
  });

  router.post('/assistant/chat', ...guard, demoLimit, async (req, res) => {
    const input = assistantChatRequestSchema.parse(req.body);
    await assistantService.admit(req.auth!);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // nginx 가 모아서 보내지 않도록 (진행 표시가 바로 보이게)
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 사용자가 패널을 닫거나 취소하면 LLM 호출도 끊는다
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const emit = (e: AssistantEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
    };
    await assistantService.chat(req.auth!, input, auditContextOf(req), emit, abort.signal);
    res.end();
  });

  return router;
}
