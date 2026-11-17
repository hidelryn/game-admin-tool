import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ApiCallError, type ApiClient } from '../api-client.js';

/** Tool 실행에 필요한 것: 이 요청의 토큰으로 묶인 API 호출기 + 토큰 권한 */
export interface ToolContext {
  api: ApiClient;
  permissions: ReadonlySet<string>;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** 토큰 권한으로 노출 여부 결정 (쓸 수 없는 Tool 은 목록에서 숨김) */
  visible(perms: ReadonlySet<string>): boolean;
  /** L3 로 막혔을 때 안내할 웹 화면 경로 */
  webPath?: string;
  run(args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext): Promise<CallToolResult>;
}

/** 타입 추론용 */
export const defineTool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> => def;

export const allOf =
  (...perms: string[]) =>
  (have: ReadonlySet<string>) =>
    perms.every((p) => have.has(p));

export const anyOf =
  (...perms: string[]) =>
  (have: ReadonlySet<string>) =>
    perms.some((p) => have.has(p));

/** MCP 단계에서 거부 (API 를 부르기 전) */
export class ToolInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// ───────────── 응답 만들기 ─────────────

/** 프롬프트 인젝션 대응: 사용자 입력 데이터는 잘라서 따옴표로 (요약 텍스트용) */
export function q(value: string | null | undefined, max = 30): string {
  const t = (value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return JSON.stringify(t.length > max ? `${t.slice(0, max)}…` : t);
}

export const num = (v: number) => v.toLocaleString('ko-KR');

export function ok(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export function fail(code: string, message: string, details?: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `실패 (${code}): ${message}` }],
    structuredContent: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

/** L2: 아직 실행 안 됨 — 사용자 확인 후 같은 입력 + 토큰으로 다시 */
function confirmationRequired(details: unknown): CallToolResult {
  const d = (details ?? {}) as {
    preview?: unknown;
    confirmationToken?: string;
    expiresAt?: string;
  };
  return ok(
    '아직 실행되지 않았습니다. 사용자에게 preview 내용을 보여 주고 확인을 받은 뒤, ' +
      '같은 입력(같은 idempotencyKey 포함)에 confirmationToken 을 넣어 다시 호출하세요. 토큰은 5분간 한 번만 쓸 수 있습니다.',
    {
      status: 'CONFIRMATION_REQUIRED',
      preview: d.preview ?? null,
      confirmationToken: d.confirmationToken ?? null,
      expiresAt: d.expiresAt ?? null,
    },
  );
}

/** L3: MCP 로는 실행 불가 — 미리보기만 전달하고 웹으로 안내 */
export function webOnly(
  preview: unknown,
  webPath: string | undefined,
  why?: string,
): CallToolResult {
  return ok(
    `${why ?? '대규모 작업이라 MCP 로는 실행할 수 없습니다.'} 아무것도 바뀌지 않았습니다. ` +
      `사용자에게 웹 백오피스${webPath ? `(${webPath})` : ''}에서 실행하라고 안내하세요.`,
    { status: 'WEB_ONLY', preview: preview ?? null, webPath: webPath ?? null },
  );
}

/** Tool 실행 + 에러를 MCP 응답으로 바꾸기 */
export async function runTool<S extends z.ZodRawShape>(
  tool: ToolDef<S>,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  // SDK 가 입력 스키마로 검증하지만, 테스트·직접 호출을 위해 한 번 더 (기본값 적용 포함)
  const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(
      'VALIDATION_FAILED',
      '입력이 올바르지 않습니다.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  try {
    return await tool.run(parsed.data as z.objectOutputType<S, z.ZodTypeAny>, ctx);
  } catch (err) {
    if (err instanceof ToolInputError) return fail(err.code, err.message, err.details);
    if (err instanceof ApiCallError) {
      if (err.code === 'CONFIRMATION_REQUIRED') return confirmationRequired(err.details);
      const preview = (err.details as { preview?: unknown } | undefined)?.preview;
      if (err.status === 403 && err.code === 'CHANNEL_NOT_ALLOWED' && preview !== undefined) {
        return webOnly(preview, tool.webPath);
      }
      return fail(err.code, err.message, err.details);
    }
    return fail('INTERNAL_ERROR', 'Tool 실행 중 오류가 발생했습니다.');
  }
}

// ───────────── 공통 입력 ─────────────

export const idempotencyKey = z
  .string()
  .uuid()
  .describe(
    '중복 실행 방지 키(UUID v4). 새 작업마다 새로 만들고, 같은 작업을 재시도하거나 확인 후 다시 부를 때는 같은 값을 쓰세요.',
  );

export const reason = z
  .string()
  .trim()
  .min(5)
  .max(200)
  .describe('작업 사유 (5~200자, 운영 로그에 기록)');

export const confirmationToken = z
  .string()
  .optional()
  .describe('CONFIRMATION_REQUIRED 를 받은 뒤 사용자가 확인했을 때만 넣으세요.');

export const publicId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,20}$/)
  .describe('회원 ID (예: U000123)');
