import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, Permission, RoleCode } from '@game-admin/shared';
import type { Executor } from '../types.js';
import { floorToSecond } from '../../../common/time.js';
import {
  adminPermissionOverrides,
  admins,
  currencies,
  items,
  permissions,
  products,
  rankingBoards,
  rankingSeasons,
  rolePermissions,
  roles,
  schedules,
} from '../schema/index.js';

const DAY = 86_400_000;
/** 시드 시즌 기간 */
const SEASON_DAYS = 28;

/**
 * 기준 데이터 시드 — 여러 번 실행해도 결과가 같다(idempotent).
 * 운영자 계정은 없을 때만 생성하고, 이미 있으면 비밀번호를 건드리지 않는다.
 */

const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'dashboard:read': '대시보드 조회',
  'user:read': '회원 목록/상세/활동 이력 조회',
  'user:read_pii': '개인정보 원문 열람',
  'user:suspend': '회원 정지/해제',
  'currency:read': '재화 잔액/이력 조회',
  'currency:grant': '재화 지급',
  'currency:deduct': '재화 회수',
  'mail:read': '우편 이력 조회',
  'mail:send': '개별 우편 발송',
  'mail:send_all': '전체 우편 발송',
  'ranking:read': '랭킹 조회',
  'ranking:manage': '랭킹 갱신/초기화',
  'audit:read': '운영 로그 조회',
  'admin:manage': '운영자 계정/권한 관리',
  'token:manage_own': '본인 API 토큰 관리',
  'schedule:read': '스케줄(시즌·이벤트) 조회',
  'schedule:manage': '스케줄(시즌·이벤트) 등록·수정',
  'maintenance:manage': '게임 점검 예약·긴급 점검·해제',
  'notice:read': '공지 조회',
  'notice:manage': '공지 등록·수정·내리기',
  'analytics:read': '유저 분석(이탈·리텐션·과금·재화 소비처) 조회',
};

/** 기본 역할 권한 (architecture.md 4.3) */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  OPERATOR: [
    Permission.DASHBOARD_READ,
    Permission.USER_READ,
    Permission.USER_SUSPEND,
    Permission.CURRENCY_READ,
    Permission.CURRENCY_GRANT,
    Permission.CURRENCY_DEDUCT,
    Permission.MAIL_READ,
    Permission.MAIL_SEND,
    Permission.RANKING_READ,
    Permission.AUDIT_READ,
    Permission.TOKEN_MANAGE_OWN,
    Permission.SCHEDULE_READ,
    Permission.SCHEDULE_MANAGE,
    Permission.MAINTENANCE_MANAGE,
    Permission.NOTICE_READ,
    Permission.NOTICE_MANAGE,
    Permission.ANALYTICS_READ,
  ],
  CS: [
    Permission.DASHBOARD_READ,
    Permission.USER_READ,
    Permission.CURRENCY_READ,
    Permission.MAIL_READ,
    Permission.MAIL_SEND,
    Permission.AUDIT_READ,
    Permission.SCHEDULE_READ,
    Permission.NOTICE_READ,
    Permission.NOTICE_MANAGE,
  ],
  VIEWER: [
    Permission.DASHBOARD_READ,
    Permission.USER_READ,
    Permission.CURRENCY_READ,
    Permission.MAIL_READ,
    Permission.RANKING_READ,
    Permission.AUDIT_READ,
    Permission.SCHEDULE_READ,
    Permission.NOTICE_READ,
    Permission.ANALYTICS_READ,
  ],
};

const ROLE_NAMES: Record<RoleCode, string> = {
  SUPER_ADMIN: '최고 관리자',
  OPERATOR: '운영자',
  CS: '고객지원',
  VIEWER: '조회 전용',
};

/** 가상 게임 재화 (requirements.md 1.1) — id 고정 */
export const SEED_CURRENCIES = [
  {
    id: 1,
    code: 'GOLD',
    name: '골드',
    isPaid: false,
    maxBalance: 999_999_999,
    grantLimitPerRequest: 1_000_000,
  },
  {
    id: 2,
    code: 'GEM',
    name: '유료 젬',
    isPaid: true,
    maxBalance: 9_999_999,
    grantLimitPerRequest: 10_000,
  },
  {
    id: 3,
    code: 'STAMINA',
    name: '행동력',
    isPaid: false,
    maxBalance: 9_999,
    grantLimitPerRequest: 500,
  },
  // 게임 플레이·이벤트로 얻는 젬. 유료 젬과 잔액을 분리해 환불·매출 집계에서 구분 (id 는 추가 순서)
  {
    id: 4,
    code: 'FREE_GEM',
    name: '무료 젬',
    isPaid: false,
    maxBalance: 9_999_999,
    grantLimitPerRequest: 10_000,
  },
] as const;

export const SEED_RANKING_BOARDS = [
  { id: 1, code: 'ARENA', name: '아레나', sortOrder: 1 },
  { id: 2, code: 'WORLD_ARENA', name: '월드아레나', sortOrder: 2 },
] as const;

export const SEED_ITEMS = [
  { id: 1001, code: 'ENHANCE_STONE', name: '강화석', stackable: true },
  { id: 1002, code: 'EXP_POTION', name: '경험치 물약', stackable: true },
  { id: 1003, code: 'SKIN_BOX', name: '스킨 상자', stackable: true },
  { id: 1004, code: 'NAME_CHANGE_TICKET', name: '닉네임 변경권', stackable: true },
] as const;

/** 가상 결제 상품 (docs/analytics.md) — id 고정 */
export const SEED_PRODUCTS = [
  {
    id: 1,
    code: 'STARTER_PACK',
    name: '스타터 패키지',
    priceKrw: 3_300,
    gemAmount: 300,
    sortOrder: 1,
  },
  { id: 2, code: 'GEM_60', name: '젬 60개', priceKrw: 1_200, gemAmount: 60, sortOrder: 2 },
  { id: 3, code: 'GEM_330', name: '젬 330개', priceKrw: 5_900, gemAmount: 330, sortOrder: 3 },
  { id: 4, code: 'GEM_700', name: '젬 700개', priceKrw: 11_000, gemAmount: 700, sortOrder: 4 },
  { id: 5, code: 'GEM_2400', name: '젬 2,400개', priceKrw: 33_000, gemAmount: 2_400, sortOrder: 5 },
  {
    id: 6,
    code: 'MONTHLY_PASS',
    name: '월정액 (30일)',
    priceKrw: 5_500,
    gemAmount: 300,
    sortOrder: 6,
  },
] as const;

export const SEED_ADMINS: { email: string; name: string; roleCode: RoleCode }[] = [
  { email: 'super@example.com', name: '최고관리자', roleCode: RoleCode.SUPER_ADMIN },
  { email: 'operator@example.com', name: '운영자', roleCode: RoleCode.OPERATOR },
  { email: 'cs@example.com', name: '고객지원', roleCode: RoleCode.CS },
  { email: 'viewer@example.com', name: '조회전용', roleCode: RoleCode.VIEWER },
];

export interface SeedCoreOptions {
  /** 시드 운영자 공통 비밀번호 (해시된 값) */
  adminPasswordHash: string;
}

export async function seedCore(db: Executor, opts: SeedCoreOptions): Promise<void> {
  // 1) 권한
  await db
    .insert(permissions)
    .values(ALL_PERMISSIONS.map((code) => ({ code, description: PERMISSION_DESCRIPTIONS[code] })))
    .onDuplicateKeyUpdate({ set: { description: sql`values(${permissions.description})` } });

  // 2) 역할
  await db
    .insert(roles)
    .values(Object.values(RoleCode).map((code) => ({ code, name: ROLE_NAMES[code] })))
    .onDuplicateKeyUpdate({ set: { name: sql`values(${roles.name})` } });

  // 없어진 권한 정리 (예: approval:review — 승인 기능 제거 2026-11-16). 개별 부여·역할 연결을 먼저 지움
  const stale = (
    await db.select({ id: permissions.id, code: permissions.code }).from(permissions)
  ).filter((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p.code));
  if (stale.length) {
    const ids = stale.map((p) => p.id);
    await db
      .delete(adminPermissionOverrides)
      .where(inArray(adminPermissionOverrides.permissionId, ids));
    await db.delete(rolePermissions).where(inArray(rolePermissions.permissionId, ids));
    await db.delete(permissions).where(inArray(permissions.id, ids));
  }

  const roleRows = await db.select({ id: roles.id, code: roles.code }).from(roles);
  const permRows = await db
    .select({ id: permissions.id, code: permissions.code })
    .from(permissions);
  const roleId = new Map(roleRows.map((r) => [r.code, r.id]));
  const permId = new Map(permRows.map((p) => [p.code, p.id]));

  // 3) 역할-권한 매핑: 기본값과 정확히 일치하도록 역할별로 교체
  for (const [code, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const rid = roleId.get(code);
    if (rid === undefined) throw new Error(`role not found: ${code}`);
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, rid));
    if (perms.length > 0) {
      await db.insert(rolePermissions).values(
        perms.map((p) => {
          const pid = permId.get(p);
          if (pid === undefined) throw new Error(`permission not found: ${p}`);
          return { roleId: rid, permissionId: pid };
        }),
      );
    }
  }

  // 4) 재화·아이템 마스터
  await db
    .insert(currencies)
    .values([...SEED_CURRENCIES])
    .onDuplicateKeyUpdate({
      set: {
        name: sql`values(${currencies.name})`,
        maxBalance: sql`values(${currencies.maxBalance})`,
        grantLimitPerRequest: sql`values(${currencies.grantLimitPerRequest})`,
      },
    });
  await db
    .insert(items)
    .values([...SEED_ITEMS])
    .onDuplicateKeyUpdate({ set: { name: sql`values(${items.name})` } });
  await db
    .insert(products)
    .values([...SEED_PRODUCTS])
    .onDuplicateKeyUpdate({
      set: {
        name: sql`values(${products.name})`,
        priceKrw: sql`values(${products.priceKrw})`,
        gemAmount: sql`values(${products.gemAmount})`,
        sortOrder: sql`values(${products.sortOrder})`,
      },
    });

  // 4-1) 랭킹 보드 (id 고정 — 1 아레나는 보드 도입 전 시즌들이 속한 곳)
  await db
    .insert(rankingBoards)
    .values([...SEED_RANKING_BOARDS])
    .onDuplicateKeyUpdate({
      set: {
        name: sql`values(${rankingBoards.name})`,
        sortOrder: sql`values(${rankingBoards.sortOrder})`,
      },
    });

  // 5) 진행 중 랭킹 시즌 (없을 때만) — 시즌은 스케줄과 1:1 (docs/schedule.md)
  const [season] = await db.select({ id: rankingSeasons.id }).from(rankingSeasons).limit(1);
  if (!season) {
    const startsAt = floorToSecond(new Date()); // DATETIME 반올림으로 미래 시각이 되지 않게
    await db.insert(rankingSeasons).values({
      boardId: 1,
      name: '아레나 시즌 1',
      status: 'ACTIVE',
      startsAt,
      endsAt: new Date(startsAt.getTime() + SEASON_DAYS * DAY),
    });
  }

  // 6) 운영자 계정 (없을 때만)
  for (const a of SEED_ADMINS) {
    const rid = roleId.get(a.roleCode);
    if (rid === undefined) throw new Error(`role not found: ${a.roleCode}`);
    const [exists] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, a.email))
      .limit(1);
    if (!exists) {
      await db.insert(admins).values({
        email: a.email,
        name: a.name,
        roleId: rid,
        passwordHash: opts.adminPasswordHash,
      });
    }
  }

  // 7) 스케줄이 없는 시즌(스케줄 기능 이전 데이터)에 스케줄을 만들어 연결 — 종료 시각이 없으면 시작 + 28일
  const [owner] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(eq(admins.email, SEED_ADMINS[0]!.email))
    .limit(1);
  if (owner) {
    const orphans = await db
      .select({
        id: rankingSeasons.id,
        name: rankingSeasons.name,
        startsAt: rankingSeasons.startsAt,
        endsAt: rankingSeasons.endsAt,
      })
      .from(rankingSeasons)
      .leftJoin(schedules, eq(schedules.rankingSeasonId, rankingSeasons.id))
      .where(isNull(schedules.id));
    for (const o of orphans) {
      const endsAt = o.endsAt ?? new Date(o.startsAt.getTime() + SEASON_DAYS * DAY);
      if (!o.endsAt)
        await db.update(rankingSeasons).set({ endsAt }).where(eq(rankingSeasons.id, o.id));
      await db.insert(schedules).values({
        kind: 'RANKING_SEASON',
        title: o.name.slice(0, 50),
        startsAt: o.startsAt,
        endsAt,
        rankingSeasonId: o.id,
        createdBy: owner.id,
        updatedBy: owner.id,
      });
    }
  }
}
