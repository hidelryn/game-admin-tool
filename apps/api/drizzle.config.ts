import { defineConfig } from 'drizzle-kit';

// drizzle-kit 은 .env 를 읽지 않으므로 루트 .env 를 직접 로드 (없으면 무시)
try {
  process.loadEnvFile('../../.env');
} catch {
  /* .env 가 없으면 이미 설정된 환경변수 사용 */
}

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다 (.env 확인)`);
  return v;
};

export default defineConfig({
  dialect: 'mysql',
  schema: './src/infra/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    database: required('MYSQL_DATABASE'),
  },
  strict: true,
  verbose: true,
});
