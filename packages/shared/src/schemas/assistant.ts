import { z } from 'zod';

/**
 * AI 어시스턴트 (docs/ai-assistant.md)
 * - 조회 전용: AI 는 기존 조회 기능(권한 검사를 거치는 서비스)만 도구로 호출한다
 * - 대화는 브라우저가 들고 있다가 매번 보낸다 (서버에 저장하지 않음, 감사 로그에 질문·사용 도구만)
 */
export const ASSISTANT_MAX_TURNS = 12;
export const ASSISTANT_QUESTION_MAX = 1000;
export const ASSISTANT_ANSWER_MAX = 4000;
export const ASSISTANT_MAX_CHARTS = 3;
export const ASSISTANT_CHART_MAX_ROWS = 120;

export const assistantMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(ASSISTANT_ANSWER_MAX),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantChatRequestSchema = z.object({
  messages: z
    .array(assistantMessageSchema)
    .min(1)
    .max(ASSISTANT_MAX_TURNS * 2)
    .refine((m) => m[m.length - 1]!.role === 'user', '마지막 메시지는 질문이어야 합니다.')
    .refine(
      (m) => m[m.length - 1]!.content.length <= ASSISTANT_QUESTION_MAX,
      `질문은 ${ASSISTANT_QUESTION_MAX}자 이내로 입력하세요.`,
    ),
});
export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

/** AI 가 그리는 차트 — 웹이 recharts 로 그린다 (AI 가 만든 HTML·스크립트는 쓰지 않음) */
export const assistantChartSchema = z.object({
  type: z.enum(['line', 'bar']),
  title: z.string().trim().min(1).max(60),
  /** 가로축으로 쓸 필드 (날짜·구간·이름) */
  xKey: z.string().min(1).max(40),
  series: z
    .array(z.object({ key: z.string().min(1).max(40), label: z.string().trim().min(1).max(30) }))
    .min(1)
    .max(4),
  data: z
    .array(z.record(z.union([z.string().max(60), z.number(), z.null()])))
    .min(1)
    .max(ASSISTANT_CHART_MAX_ROWS),
  /** 값 단위 (예: 명, 원, %) */
  unit: z.string().trim().max(10).optional(),
});
export type AssistantChart = z.infer<typeof assistantChartSchema>;

/** 스트리밍 응답 (줄 단위 JSON, application/x-ndjson) */
export type AssistantEvent =
  /** 도구 호출 시작 — "회원 조회 중…" 표시용 */
  | { type: 'tool'; name: string; label: string }
  /** 도구 결과 (성공/실패만, 데이터는 보내지 않음) */
  | { type: 'tool_done'; name: string; ok: boolean }
  | { type: 'answer'; text: string; charts: AssistantChart[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number } };

export interface AssistantStatus {
  configured: boolean;
  model: string | null;
  /** 이 운영자가 쓸 수 있는 도구 (권한에 따라) */
  tools: { name: string; label: string }[];
  limits: { perHour: number; demoPerIpDay: number | null };
}
