import { Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type {
  GameMaintenanceState,
  MaintenanceStatus,
  NoticeCategory,
  NoticeStatus,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';

export const MAINTENANCE_STATUS: Record<MaintenanceStatus, { label: string; color: string }> = {
  SCHEDULED: { label: '예정', color: 'blue' },
  ACTIVE: { label: '점검 중', color: 'red' },
  ENDED: { label: '종료', color: 'default' },
  CANCELED: { label: '취소', color: 'default' },
};

export const NOTICE_STATUS: Record<NoticeStatus, { label: string; color: string }> = {
  SCHEDULED: { label: '게시 예정', color: 'blue' },
  ACTIVE: { label: '게시 중', color: 'green' },
  ENDED: { label: '게시 종료', color: 'default' },
  HIDDEN: { label: '내림', color: 'default' },
};

export const CATEGORY_LABEL: Record<NoticeCategory, string> = {
  NOTICE: '안내',
  UPDATE: '업데이트',
  EVENT: '이벤트',
  MAINTENANCE: '점검',
};

const CATEGORY_COLOR: Record<NoticeCategory, string> = {
  NOTICE: 'default',
  UPDATE: 'geekblue',
  EVENT: 'orange',
  MAINTENANCE: 'red',
};

export function MaintenanceStatusTag({ status }: { status: MaintenanceStatus }) {
  const s = MAINTENANCE_STATUS[status];
  return <Tag color={s.color}>{s.label}</Tag>;
}

export function NoticeStatusTag({ status }: { status: NoticeStatus }) {
  const s = NOTICE_STATUS[status];
  return <Tag color={s.color}>{s.label}</Tag>;
}

export function CategoryTag({ category }: { category: NoticeCategory }) {
  return <Tag color={CATEGORY_COLOR[category]}>{CATEGORY_LABEL[category]}</Tag>;
}

export const fmt = (s: string | null | undefined) =>
  s ? dayjs(s).format('YYYY-MM-DD HH:mm') : '계속';

export const fmtRange = (a: string, b: string | null) => `${fmt(a)} ~ ${fmt(b)}`;

/** 남은 시간 "1시간 20분" */
export function remain(until: string): string {
  const min = Math.max(0, dayjs(until).diff(dayjs(), 'minute'));
  const h = Math.floor(min / 60);
  return h ? `${h}시간 ${min % 60}분` : `${min}분`;
}

/** 지금 점검 상태 — 상단 띠·점검 탭 공용 (30초마다) */
export function useCurrentMaintenance() {
  return useQuery({
    queryKey: ['maintenance-current'],
    queryFn: async () => (await api.get<GameMaintenanceState>('/maintenances/current')).data,
    refetchInterval: 30_000,
  });
}
