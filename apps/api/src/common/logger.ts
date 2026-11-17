import pino from 'pino';

/**
 * 구조화 로그. 민감 필드는 자동 마스킹 (architecture.md 5장)
 */
export function createLogger(opts: { level: string; pretty: boolean }) {
  return pino({
    level: opts.level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
      ],
      censor: '[REDACTED]',
    },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
