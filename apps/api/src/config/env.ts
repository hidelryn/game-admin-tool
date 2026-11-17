import { z } from 'zod';
import { passwordPolicySchema } from '@game-admin/shared';

/**
 * 환경변수는 시작 시 한 번 검증한다. 누락·형식 오류면 즉시 기동 실패 (architecture.md 5장).
 * 비밀값은 여기서도 기본값을 두지 않는다.
 */
const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGINS: csv,

    MYSQL_HOST: z.string().min(1),
    MYSQL_PORT: z.coerce.number().int().positive().default(3306),
    MYSQL_DATABASE: z.string().min(1),
    MYSQL_USER: z.string().min(1),
    MYSQL_PASSWORD: z.string().min(1),
    MYSQL_POOL_SIZE: z.coerce.number().int().positive().default(10),

    REDIS_URL: z.string().url(),
    REDIS_KEY_PREFIX: z.string().default('ga:dev:'),

    // 인증 (architecture.md 4.1)
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET 는 32자 이상이어야 합니다.'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    /** 같은 refresh 토큰이 이 시간 안에 다시 오면 탈취가 아니라 동시 요청(여러 탭)으로 본다 */
    REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).max(60).default(10),
    /** 미지정 시 production 에서만 Secure 쿠키 */
    COOKIE_SECURE: bool.optional(),
    // argon2id 파라미터 — 기본값은 OWASP 권장 최소치 (19 MiB, 2회)
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(4096).default(19456),
    ARGON2_TIME_COST: z.coerce
      .number()
      .int()
      .min(2, 'argon2 timeCost 는 2 이상이어야 합니다.')
      .default(2),

    /** 랭킹 기록 순서 번호의 서버 번호 (0~9). API 를 여러 대 띄우면 서버마다 다르게 */
    RANKING_NODE_ID: z.coerce.number().int().min(0).max(9).default(0),
    /** 로그인 시도 IP당 분당 허용 횟수 */
    LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
    /** 통계 날짜 기준 시간대 (분). 기본 KST(+9) */
    STAT_TZ_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(540),
    /**
     * 게임 서버(시뮬레이터)용 내부 API 키. 비어 있으면 내부 API 비활성.
     * production 에서는 값이 있어도 비활성 (인증 없이 재화를 만들 수 있는 경로이므로)
     */
    /** 업로드 이미지 로컬 저장 폴더 (API 실행 위치 기준). 배포 때 S3 로 교체 예정 */
    ASSET_STORAGE_DIR: z.string().min(1).default('storage/uploads'),

    INTERNAL_API_KEY: z
      .string()
      .min(32, 'INTERNAL_API_KEY 는 32자 이상이어야 합니다.')
      .optional()
      .or(z.literal('').transform(() => undefined)),

    /**
     * 체험 모드 (docs/demo-mode.md) — 포트폴리오 방문자용 공개 계정
     * DEMO_MODE: 로그인 화면에 체험 계정 표시 + 계정 생성·제한
     * DEMO_DAILY_RESET: 매일 04:00(KST) 데이터 전체 초기화 ⚠️ DEMO_MODE 와 둘 다 켜야 동작
     */
    DEMO_MODE: bool.default('false'),
    DEMO_ACCOUNT_EMAIL: z.string().trim().toLowerCase().email().default('demo@example.com'),
    DEMO_ACCOUNT_PASSWORD: z
      .string()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    DEMO_DAILY_RESET: bool.default('false'),
    /** 체험 모드 가상 활동: 5분마다 이만큼의 회원이 접속·재화 획득/소비 (0 = 끔). DEMO_MODE 일 때만 */
    DEMO_ACTIVITY_USERS: z.coerce.number().int().min(0).max(200).default(30),
  })
  .superRefine((v, ctx) => {
    if (v.DEMO_MODE && !passwordPolicySchema.safeParse(v.DEMO_ACCOUNT_PASSWORD).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEMO_ACCOUNT_PASSWORD'],
        message: 'DEMO_MODE 를 켜면 체험 계정 비밀번호(10자 이상, 영문·숫자 포함)가 필요합니다.',
      });
    }
    if (v.DEMO_DAILY_RESET && !v.DEMO_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEMO_DAILY_RESET'],
        message: '매일 초기화는 DEMO_MODE 와 함께만 켤 수 있습니다.',
      });
    }
  });

export type Env = Omit<z.infer<typeof EnvSchema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // 로거 초기화 전이므로 console 사용
    console.error(`[config] 환경변수 검증 실패\n${issues}`);
    throw new Error('Invalid environment variables');
  }
  const env = parsed.data;
  return { ...env, COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production' };
}
