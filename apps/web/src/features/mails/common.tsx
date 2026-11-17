import { Tag, Tooltip } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  MAIL_MAX_RECIPIENTS,
  type MailRewardView,
  type MailStatus,
  type MailType,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { cellText, type Cell } from '../../shared/file/table-file';
import { fmtNumber } from '../../shared/format';

export interface ItemInfo {
  code: string;
  name: string;
  stackable: boolean;
}

/** 아이템 마스터 (거의 바뀌지 않으므로 5분 캐시) */
export function useItems() {
  return useQuery({
    queryKey: ['items'],
    queryFn: async () => (await api.get<ItemInfo[]>('/items')).data,
    staleTime: 5 * 60_000,
  });
}

export const MAIL_TYPE_LABEL: Record<MailType, string> = { USER: '개별', GLOBAL: '전체' };

/** 발송됐지만 유효기간이 지난 우편은 "만료"로 보여준다 (DB 상태는 SENT 그대로) */
export function MailStatusTag({ status, expiresAt }: { status: MailStatus; expiresAt: string }) {
  if (status === 'CANCELED') return <Tag color="default">취소</Tag>;
  if (status === 'SCHEDULED') return <Tag color="blue">예약</Tag>;
  if (dayjs(expiresAt).isBefore(dayjs())) return <Tag color="orange">만료</Tag>;
  return <Tag color="green">발송</Tag>;
}

export function RewardTags({ rewards }: { rewards: MailRewardView[] }) {
  if (!rewards.length) return <span style={{ color: '#8c8c8c' }}>보상 없음</span>;
  return (
    <>
      {rewards.map((r) => (
        <Tooltip key={`${r.type}:${r.code}`} title={r.code}>
          <Tag color={r.type === 'CURRENCY' ? 'gold' : 'purple'} style={{ marginBottom: 2 }}>
            {r.name} ×{fmtNumber(r.quantity)}
          </Tag>
        </Tooltip>
      ))}
    </>
  );
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,20}$/;

export interface RecipientParse {
  ids: string[];
  /** 형식이 틀린 값과 행 번호 */
  invalid: { row: number; value: string }[];
  duplicates: number;
}

/**
 * 우편 대상 파일: 회원 ID 한 열 (머리글에 "회원"/"id" 가 있으면 그 열, 없으면 첫 열)
 * 다른 열이 있어도 무시한다 → 대량 지급 파일을 그대로 올려도 회원 ID 만 뽑힌다
 */
export function parseRecipientCells(cells: Cell[][]): RecipientParse {
  const rows = cells
    .map((c, i) => ({ c, row: i + 1 }))
    .filter((r) => r.c.some((x) => cellText(x) !== ''));
  const head = rows[0]?.c.map(cellText) ?? [];
  const headerCol = head.findIndex((h) => /^(회원|public|user|id$|uid)/i.test(h));
  const col = headerCol === -1 ? 0 : headerCol;
  const data = headerCol === -1 ? rows : rows.slice(1);
  return mergeIds(
    [],
    data.map((r) => ({ row: r.row, value: cellText(r.c[col]) })),
  );
}

/** 기존 목록에 새 값을 합친다 (순서 유지, 중복 제거, 형식 검사) */
export function mergeIds(
  existing: string[],
  incoming: { row: number; value: string }[],
): RecipientParse {
  const seen = new Set(existing);
  const ids = [...existing];
  const invalid: RecipientParse['invalid'] = [];
  let duplicates = 0;
  for (const { row, value } of incoming) {
    if (!value) continue;
    if (!PUBLIC_ID.test(value)) {
      invalid.push({ row, value });
      continue;
    }
    if (seen.has(value)) {
      duplicates++;
      continue;
    }
    seen.add(value);
    ids.push(value);
  }
  return { ids, invalid, duplicates };
}

export const recipientLimitText = `최대 ${fmtNumber(MAIL_MAX_RECIPIENTS)}명`;
