import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CalendarOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  Permission,
  type RankingEntry,
  type RankingSeasonView,
  type UserRankView,
} from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { ReasonField } from '../../shared/components/ReasonField';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { SnapshotsTab } from './SnapshotsTab';
import { useRankingBoards } from '../schedules/common';

const PAGE_SIZE = 50;
const MEDAL = ['#d4a017', '#9e9e9e', '#b0703c'];

const SEASON_STATUS: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: '진행 중', color: 'green' },
  ENDED: { label: '종료', color: 'default' },
  SCHEDULED: { label: '예정', color: 'blue' },
  CANCELED: { label: '취소', color: 'default' },
};

function RankCell({ rank }: { rank: number }) {
  return rank <= 3 ? (
    <span style={{ fontWeight: 700, color: MEDAL[rank - 1] }}>{rank}</span>
  ) : (
    <span>{fmtNumber(rank)}</span>
  );
}

const entryColumns = (highlight?: string) => [
  { title: '순위', dataIndex: 'rank', width: 80, render: (r: number) => <RankCell rank={r} /> },
  {
    title: '회원',
    dataIndex: 'publicId',
    width: 140,
    render: (v: string) => (v ? <Link to={`/users/${v}`}>{v}</Link> : '-'),
  },
  {
    title: '닉네임',
    dataIndex: 'nickname',
    render: (v: string, r: RankingEntry) => (r.publicId === highlight ? <b>{v}</b> : v),
  },
  { title: '점수', dataIndex: 'score', align: 'right' as const, width: 140, render: fmtNumber },
  {
    title: '기록 시각',
    dataIndex: 'achievedAt',
    width: 160,
    render: (v: string) => fmtDateTime(v),
  },
];

/**
 * 랭킹 — 시즌별 현재 순위(Redis), 회원 순위 찾기, 초기화 스냅샷, 관리(재구성·초기화 요청)
 * 같은 점수는 먼저 기록한 회원이 위 (docs/database.md 4.4)
 */
export function RankingsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'rebuild' | 'reset' | null>(null);

  const seasons = useQuery({
    queryKey: ['ranking-seasons'],
    queryFn: async () => (await api.get<RankingSeasonView[]>('/ranking-seasons')).data,
  });

  const boards = useRankingBoards();

  // 랭킹 종류(보드) → 시즌. 시즌이 지정돼 있으면 그 시즌의 보드, 아니면 ?board= 또는 첫 보드
  const seasonId = Number(params.get('season')) || undefined;
  const season = seasons.data?.find((s) => s.id === seasonId);
  const boardId = season?.board.id ?? (Number(params.get('board')) || boards.data?.[0]?.id);
  const boardSeasons = useMemo(
    () => seasons.data?.filter((s) => s.board.id === boardId) ?? [],
    [seasons.data, boardId],
  );

  // 시즌 미지정이면 그 보드의 진행 중 시즌(없으면 가장 최근 시즌)
  useEffect(() => {
    if (!seasonId && boardId && boardSeasons.length) {
      const pick = boardSeasons.find((s) => s.status === 'ACTIVE') ?? boardSeasons[0]!;
      setParams({ board: String(boardId), season: String(pick.id) }, { replace: true });
    }
  }, [seasonId, boardId, boardSeasons, setParams]);
  const tab = params.get('tab') ?? 'live';
  const canManage = can(Permission.RANKING_MANAGE);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['ranking'] });
    void queryClient.invalidateQueries({ queryKey: ['ranking-seasons'] });
  };

  return (
    <>
      <PageHeader
        title="랭킹"
        extra={
          <Space wrap>
            {can(Permission.SCHEDULE_READ) && (
              <Tooltip title="시즌 생성·기간 변경·조기 종료는 스케줄에서 합니다">
                <Link to="/schedules?kind=RANKING_SEASON">
                  <Button icon={<CalendarOutlined />}>시즌 일정</Button>
                </Link>
              </Tooltip>
            )}
            <Segmented<number>
              value={boardId}
              onChange={(v) => setParams({ board: String(v) })}
              options={(boards.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
            />
            <Select
              style={{ width: 240 }}
              loading={seasons.isLoading}
              value={seasonId}
              onChange={(v) => setParams({ board: String(boardId), season: String(v) })}
              placeholder="이 랭킹에 시즌이 없습니다"
              options={boardSeasons.map((s) => ({
                value: s.id,
                label: `${s.name} (${SEASON_STATUS[s.status]?.label ?? s.status})`,
              }))}
            />
            {canManage && season && (
              <>
                <Button icon={<SyncOutlined />} onClick={() => setDialog('rebuild')}>
                  재구성
                </Button>
                <Button danger icon={<WarningOutlined />} onClick={() => setDialog('reset')}>
                  초기화 요청
                </Button>
              </>
            )}
          </Space>
        }
      />

      {season && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
            <Descriptions.Item label="상태">
              <Tag color={SEASON_STATUS[season.status]?.color}>
                {SEASON_STATUS[season.status]?.label ?? season.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="시작">{fmtDateTime(season.startsAt)}</Descriptions.Item>
            <Descriptions.Item label="종료">
              {season.endsAt ? fmtDateTime(season.endsAt) : '미정'}
            </Descriptions.Item>
            <Descriptions.Item label="초기화">{fmtNumber(season.resetCount)}회</Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {seasonId && (
        <Card>
          <Tabs
            activeKey={tab}
            onChange={(t) =>
              setParams({
                board: String(boardId),
                season: String(seasonId),
                ...(t === 'live' ? {} : { tab: t }),
              })
            }
            items={[
              { key: 'live', label: '현재 순위', children: <LiveRanking seasonId={seasonId} /> },
              {
                key: 'snapshots',
                label: '스냅샷',
                children: season && <SnapshotsTab season={season} />,
              },
            ]}
          />
        </Card>
      )}
      {seasons.data && boardSeasons.length === 0 && (
        <Empty description="이 랭킹에는 아직 시즌이 없습니다 — 스케줄에서 시즌을 만들어 주세요" />
      )}

      {season && (
        <ManageModal
          kind={dialog}
          season={season}
          onClose={() => setDialog(null)}
          onDone={refreshAll}
        />
      )}
    </>
  );
}

/** 현재 순위 + 회원 순위 찾기. 30초마다 자동 갱신 */
function LiveRanking({ seasonId }: { seasonId: number }) {
  const [page, setPage] = useState(1);
  const [lookup, setLookup] = useState<string>();
  useEffect(() => setPage(1), [seasonId]);

  const board = useQuery({
    queryKey: ['ranking', seasonId, 'board', page],
    queryFn: () =>
      api.get<{ season: RankingSeasonView; entries: RankingEntry[] }>(
        `/ranking-seasons/${seasonId}/rankings`,
        {
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        },
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const mine = useQuery({
    queryKey: ['ranking', seasonId, 'user', lookup],
    queryFn: async () =>
      (
        await api.get<UserRankView>(
          `/ranking-seasons/${seasonId}/rankings/users/${encodeURIComponent(lookup!)}`,
        )
      ).data,
    enabled: !!lookup,
    retry: false,
  });

  const total = Number(board.data?.meta?.total ?? 0);

  return (
    <>
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder="회원 ID로 순위 찾기"
          allowClear
          enterButton={<SearchOutlined />}
          style={{ width: 280 }}
          onSearch={(v) => setLookup(v.trim() || undefined)}
        />
        <Space>
          <Typography.Text type="secondary">
            참여 {fmtNumber(total)}명 · 30초마다 갱신
          </Typography.Text>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={board.isFetching}
            onClick={() => board.refetch()}
          />
        </Space>
      </Flex>

      {lookup && (
        <Card
          size="small"
          style={{ marginBottom: 16, background: '#fafcff' }}
          title={`${lookup} 주변 순위`}
          extra={
            <Button size="small" type="text" onClick={() => setLookup(undefined)}>
              닫기
            </Button>
          }
        >
          {mine.error ? (
            <Typography.Text type="danger">
              {mine.error instanceof ApiError ? mine.error.message : '조회에 실패했습니다.'}
            </Typography.Text>
          ) : mine.data && !mine.data.me ? (
            <Typography.Text type="secondary">이 시즌에 기록이 없는 회원입니다.</Typography.Text>
          ) : (
            <Table<RankingEntry>
              rowKey="publicId"
              size="small"
              loading={mine.isLoading}
              pagination={false}
              dataSource={mine.data?.neighbors ?? []}
              columns={entryColumns(lookup)}
              rowClassName={(r) => (r.publicId === lookup ? 'ant-table-row-selected' : '')}
            />
          )}
        </Card>
      )}

      {board.error ? (
        <Alert
          type="error"
          showIcon
          message="랭킹을 불러오지 못했습니다"
          description={board.error instanceof ApiError ? board.error.message : undefined}
        />
      ) : (
        <Table<RankingEntry>
          rowKey="publicId"
          size="small"
          loading={board.isLoading}
          dataSource={board.data?.data.entries ?? []}
          columns={entryColumns()}
          locale={{ emptyText: <Empty description="아직 기록이 없습니다" /> }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: Math.min(total, 100_000 + PAGE_SIZE), // 서버 offset 상한 100,000
            showSizeChanger: false,
            showTotal: (n) => `${fmtNumber(n)}명`,
            onChange: setPage,
          }}
        />
      )}
    </>
  );
}

/**
 * 관리 작업
 * - 재구성(L1): DB(원본) 기준으로 Redis 순위를 다시 만든다. 순위가 이상해 보일 때 사용, 점수는 바뀌지 않음
 * - 초기화(L3): 현재 순위를 스냅샷으로 남기고 비운다 — 빨간 경고로 한 번 더 확인 후 실행 (웹 전용)
 */
function ManageModal({
  kind,
  season,
  onClose,
  onDone,
}: {
  kind: 'rebuild' | 'reset' | null;
  season: RankingSeasonView;
  onClose(): void;
  onDone(): void;
}) {
  const [form] = Form.useForm<{ reason: string; confirmName?: string }>();
  const [loading, setLoading] = useState(false);
  const run = useSafeAction();
  const { modal } = App.useApp();
  const isReset = kind === 'reset';

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    const res = await run<{ loaded?: number; archivedCount?: number }>({
      request: ({ idempotencyKey, confirmationToken }) =>
        api.post(
          `/ranking-seasons/${season.id}/${isReset ? 'reset' : 'rebuild'}`,
          { reason: v.reason, ...(confirmationToken ? { confirmationToken } : {}) },
          { idempotencyKey },
        ),
      confirmTitle: '랭킹 초기화 최종 확인',
      successMessage: isReset ? '초기화했습니다. 직전 순위는 스냅샷 탭에 있습니다.' : undefined,
    });
    setLoading(false);
    if (!res) return;
    if (!isReset) {
      modal.success({
        title: '재구성했습니다',
        content: `${fmtNumber(res.data.loaded ?? 0)}명의 기록을 다시 불러왔습니다.`,
      });
    }
    form.resetFields();
    onClose();
    onDone();
  }

  return (
    <Modal
      open={kind !== null}
      title={isReset ? `랭킹 초기화 — ${season.name}` : `랭킹 재구성 — ${season.name}`}
      onCancel={onClose}
      onOk={submit}
      okText={isReset ? '다음' : '재구성'}
      okButtonProps={{ danger: isReset, loading }}
      destroyOnHidden
    >
      {isReset ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="시즌의 모든 기록이 비워집니다"
          description="실행 직전 순위는 스냅샷으로 남아 복원할 수 있습니다. 다음 단계에서 지워질 인원을 한 번 더 확인합니다."
        />
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="DB 기록으로 순위를 다시 만듭니다"
          description="점수는 바뀌지 않습니다. 순위가 DB와 다르게 보일 때 사용하세요. 10분마다 자동으로도 맞춰집니다."
        />
      )}
      <Form form={form} layout="vertical" preserve={false}>
        {isReset && (
          <Form.Item
            name="confirmName"
            label={
              <span>
                확인을 위해 시즌 이름 <Typography.Text code>{season.name}</Typography.Text> 을
                입력하세요
              </span>
            }
            rules={[
              {
                validator: async (_, v) =>
                  v === season.name
                    ? undefined
                    : Promise.reject(new Error('시즌 이름이 일치하지 않습니다.')),
              },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
        )}
        <ReasonField />
      </Form>
    </Modal>
  );
}
