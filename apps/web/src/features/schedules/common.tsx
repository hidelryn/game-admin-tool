import { Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  type RankingBoardView,
  type ScheduleKind,
  type ScheduleStatus,
  type ScheduleView,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';

export const KIND_LABEL: Record<ScheduleKind, string> = {
  RANKING_SEASON: '랭킹 시즌',
  EVENT: '게임 이벤트',
};

/** 범주 색 (shared/charts/palette 와 같은 계열, 종류별 고정) */
export const KIND_COLOR: Record<ScheduleKind, string> = {
  RANKING_SEASON: '#2a78d6',
  EVENT: '#eb6834',
};

export const STATUS_LABEL: Record<ScheduleStatus, { label: string; color: string }> = {
  SCHEDULED: { label: '예정', color: 'blue' },
  ACTIVE: { label: '진행 중', color: 'green' },
  ENDED: { label: '종료', color: 'default' },
  CANCELED: { label: '취소', color: 'default' },
};

export const FREQUENCY_LABEL = {
  ONCE: '한 번만',
  DAILY: '하루 한 번',
  EVERY_LOGIN: '접속할 때마다',
} as const;

export function StatusTag({ status }: { status: ScheduleStatus }) {
  const s = STATUS_LABEL[status];
  return <Tag color={s.color}>{s.label}</Tag>;
}

export function KindTag({ kind }: { kind: ScheduleKind }) {
  return (
    <Tag color={KIND_COLOR[kind]} style={{ color: '#fff', border: 'none' }}>
      {KIND_LABEL[kind]}
    </Tag>
  );
}

export const fmtPeriod = (s: Pick<ScheduleView, 'startsAt' | 'endsAt'>) =>
  `${dayjs(s.startsAt).format('YYYY-MM-DD HH:mm')} ~ ${dayjs(s.endsAt).format('YYYY-MM-DD HH:mm')}`;

/** 랭킹 종류(보드) 목록 — 시드로 고정이라 길게 캐시 */
export function useRankingBoards() {
  return useQuery({
    queryKey: ['ranking-boards'],
    queryFn: async () => (await api.get<RankingBoardView[]>('/ranking-boards')).data,
    staleTime: 10 * 60_000,
  });
}

/** 시즌이면 "[월드아레나] 시즌 1" 처럼 보드를 앞에 */
export const scheduleLabel = (s: Pick<ScheduleView, 'title' | 'rankingSeason'>) =>
  s.rankingSeason ? `[${s.rankingSeason.board.name}] ${s.title}` : s.title;
