/**
 * LLM 호출 (Anthropic Messages API) — docs/ai-assistant.md
 * - SDK 없이 fetch 로 직접 호출 (의존성 최소화). 키는 env(ANTHROPIC_API_KEY)로만 받는다
 * - 테스트는 createScriptedLlm 으로 정해진 응답을 돌려준다
 */
export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContent[];
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: LlmContent[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  readonly configured: boolean;
  readonly model: string | null;
  create(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 45_000;

export function createAnthropicLlm(opts: { apiKey?: string; model: string }): LlmClient {
  if (!opts.apiKey) {
    return {
      configured: false,
      model: null,
      create: () => Promise.reject(new LlmError('ANTHROPIC_API_KEY 가 설정되지 않았습니다.', null)),
    };
  }
  const apiKey = opts.apiKey;
  return {
    configured: true,
    model: opts.model,
    async create(req) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
        }),
        signal,
      });
      const body = (await res.json().catch(() => null)) as {
        content?: LlmContent[];
        stop_reason?: string | null;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.content) {
        // 응답 본문(키·요청 내용이 섞일 수 있음)은 그대로 내보내지 않고 상태만
        throw new LlmError(`LLM 호출 실패 (HTTP ${res.status})`, res.status);
      }
      return {
        content: body.content,
        stopReason: body.stop_reason ?? null,
        usage: {
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

/** 테스트용: 호출될 때마다 다음 응답을 돌려주고, 받은 요청을 기록 */
export function createScriptedLlm(script: LlmResponse[] = []) {
  const requests: LlmRequest[] = [];
  const queue = [...script];
  return {
    configured: true,
    model: 'scripted',
    requests,
    queue,
    async create(req: LlmRequest): Promise<LlmResponse> {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const next = queue.shift();
      if (!next) throw new LlmError('scripted llm: 응답이 더 없습니다', 500);
      return next;
    },
  } satisfies LlmClient & { requests: LlmRequest[]; queue: LlmResponse[] };
}
