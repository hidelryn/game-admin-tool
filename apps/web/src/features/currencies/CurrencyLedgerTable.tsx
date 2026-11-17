import { Button, Empty, Table, Tag, Tooltip, Typography } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { CurrencyTransaction } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { fmtDateTime, fmtNumber, fmtSigned } from '../../shared/format';
import { CHANNEL_LABEL, SOURCE_LABEL, currencyLabel, useCurrencies } from './common';

export interface LedgerFilter {
  publicId?: string;
  currencyCode?: string;
  source?: string;
  from?: string;
  to?: string;
}

const SOURCE_COLOR: Record<string, string> = { ADMIN: 'purple', MAIL: 'blue', GAME: 'default' };

/**
 * 재화 원장 (커서 페이지네이션, "더 보기")
 * - publicId 를 고정하면 회원 상세의 탭으로 사용
 */
export function CurrencyLedgerTable({
  filter,
  showUser = true,
  onUserClick,
}: {
  filter: LedgerFilter;
  showUser?: boolean;
  /** 지정하면 회원 ID 클릭 시 페이지 이동 대신 이 함수를 호출 (재화 관리 화면에 머무름) */
  onUserClick?(publicId: string): void;
}) {
  const currencies = useCurrencies();
  const ledger = useInfiniteQuery({
    queryKey: ['currency-transactions', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<CurrencyTransaction[]>('/currency-transactions', {
        ...filter,
        size: 30,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => (last.meta?.nextCursor as string | null | undefined) ?? undefined,
  });

  const rows = ledger.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <Table<CurrencyTransaction>
        rowKey="id"
        size="small"
        loading={ledger.isLoading}
        pagination={false}
        dataSource={rows}
        scroll={{ x: 900 }}
        locale={{
          emptyText: (
            <Empty description={ledger.error ? ledger.error.message : '거래 내역이 없습니다'} />
          ),
        }}
        columns={[
          { title: '시각', dataIndex: 'createdAt', width: 150, render: fmtDateTime },
          ...(showUser
            ? [
                {
                  title: '회원',
                  dataIndex: 'publicId',
                  width: 120,
                  render: (v: string | null) =>
                    !v ? (
                      '-'
                    ) : onUserClick ? (
                      <Typography.Link onClick={() => onUserClick(v)}>{v}</Typography.Link>
                    ) : (
                      <Link to={`/users/${v}`}>{v}</Link>
                    ),
                },
              ]
            : []),
          {
            title: '재화',
            dataIndex: 'currencyCode',
            width: 130,
            render: (c: string) => currencyLabel(currencies.data, c),
          },
          {
            title: '변경',
            dataIndex: 'delta',
            width: 110,
            align: 'right',
            render: (d: number) => (
              <Typography.Text type={d < 0 ? 'danger' : 'success'}>{fmtSigned(d)}</Typography.Text>
            ),
          },
          {
            title: '잔액',
            width: 170,
            align: 'right',
            render: (_, r) => (
              <span style={{ whiteSpace: 'nowrap' }}>
                <Typography.Text type="secondary">{fmtNumber(r.balanceBefore)} →</Typography.Text>{' '}
                {fmtNumber(r.balanceAfter)}
              </span>
            ),
          },
          {
            title: '출처',
            dataIndex: 'source',
            width: 80,
            render: (s: string) => <Tag color={SOURCE_COLOR[s]}>{SOURCE_LABEL[s] ?? s}</Tag>,
          },
          {
            title: '처리자',
            width: 120,
            render: (_, r) =>
              r.adminName ? (
                <Tooltip
                  title={r.channel ? `${CHANNEL_LABEL[r.channel] ?? r.channel} 채널` : undefined}
                >
                  {r.adminName}
                  {r.channel === 'MCP' && (
                    <Tag color="geekblue" style={{ marginLeft: 4 }}>
                      MCP
                    </Tag>
                  )}
                </Tooltip>
              ) : (
                '-'
              ),
          },
          {
            title: '사유',
            dataIndex: 'reason',
            ellipsis: true,
            render: (v: string | null) => v ?? '-',
          },
        ]}
      />
      {ledger.hasNextPage && (
        <Button
          block
          style={{ marginTop: 12 }}
          loading={ledger.isFetchingNextPage}
          onClick={() => ledger.fetchNextPage()}
        >
          더 보기
        </Button>
      )}
    </>
  );
}
