import { describe, expect, it } from 'vitest';
import {
  createMaintenanceRequestSchema,
  maintenanceStatusOf,
  noticeStatusOf,
} from '@game-admin/shared';

const at = (iso: string) => new Date(iso);
const now = at('2026-11-15T03:00:00Z');

describe('점검 상태 (시각으로 계산)', () => {
  const base = {
    startsAt: '2026-11-15T02:00:00Z',
    endsAt: '2026-11-15T04:00:00Z',
    endedAt: null,
    canceledAt: null,
  };
  it('예정 → 진행 → 종료', () => {
    expect(maintenanceStatusOf(base, at('2026-11-15T01:59:59Z'))).toBe('SCHEDULED');
    expect(maintenanceStatusOf(base, now)).toBe('ACTIVE');
    expect(maintenanceStatusOf(base, at('2026-11-15T04:00:00Z'))).toBe('ENDED');
  });
  it('지금 열기(ended_at)는 예정 종료보다 우선', () => {
    expect(maintenanceStatusOf({ ...base, endedAt: '2026-11-15T02:30:00Z' }, now)).toBe('ENDED');
  });
  it('취소가 가장 우선', () => {
    expect(maintenanceStatusOf({ ...base, canceledAt: '2026-11-15T01:00:00Z' }, now)).toBe(
      'CANCELED',
    );
  });
});

describe('공지 상태', () => {
  it('종료 없음 = 계속 게시, 내리면 HIDDEN', () => {
    const n = { startsAt: '2026-11-15T00:00:00Z', endsAt: null, hiddenAt: null };
    expect(noticeStatusOf(n, now)).toBe('ACTIVE');
    expect(noticeStatusOf({ ...n, hiddenAt: '2026-11-15T01:00:00Z' }, now)).toBe('HIDDEN');
    expect(noticeStatusOf({ ...n, endsAt: '2026-11-15T02:00:00Z' }, now)).toBe('ENDED');
  });
});

describe('점검 요청 검증', () => {
  const ok = {
    title: '점검',
    message: '점검합니다',
    endsAt: '2026-11-16T00:00:00Z',
    reason: '정기 점검 예약',
  };
  it('예약은 시작 시각 필수, 긴급은 없어도 됨', () => {
    expect(createMaintenanceRequestSchema.safeParse(ok).success).toBe(false);
    expect(createMaintenanceRequestSchema.safeParse({ ...ok, startNow: true }).success).toBe(true);
  });
  it('예외 회원 중복·형식 오류는 거부', () => {
    const r = (ids: string[]) =>
      createMaintenanceRequestSchema.safeParse({ ...ok, startNow: true, allowPublicIds: ids })
        .success;
    expect(r(['U1', 'U1'])).toBe(false);
    expect(r(['bad id'])).toBe(false);
    expect(r(['U1', 'U2'])).toBe(true);
  });
});
