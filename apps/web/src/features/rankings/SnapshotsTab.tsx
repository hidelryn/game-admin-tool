import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  GiftOutlined,
  HistoryOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Permission,
  RANKING_REWARD_MAX_RECIPIENTS,
  RANKING_REWARD_MAX_TIERS,
  tierLabel,
  tierSize,
  type RankingEntry,
  type RankingSeasonView,
  type RankingSnapshotSummary,
} from '@game-admin/shared';
import { api, ApiError, downloadFile } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ReasonField } from '../../shared/components/ReasonField';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { RewardsEditor, type RewardInput } from '../mails/RewardsEditor';

const PAGE_SIZE = 50;
const MEDAL = ['#d4a017', '#9e9e9e', '#b0703c'];
type SnapshotRow = Omit<RankingEntry, 'achievedAt'>;

/**
 * 초기화·복원 스냅샷
 * - 순위 보기(서랍), CSV 내보내기(운영 로그 기록)
 * - 순위 보상 우편(L3, 스냅샷당 1회), 복원(L3, 현재 순위 교체 + 직전 상태 자동 보관)
 */
export function SnapshotsTab({ season }: { season: RankingSeasonView }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const canManage = can(Permission.RANKING_MANAGE);
  const [viewing, setViewing] = useState<RankingSnapshotSummary>();
  const [rewarding, setRewarding] = useState<RankingSnapshotSummary>();
  const [restoring, setRestoring] = useState<RankingSnapshotSummary>();
  const [downloading, setDownloading] = useState<string>();

  const list = useQuery({
    queryKey: ['ranking', season.id, 'snapshots'],
    queryFn: async () =>
      (await api.get<RankingSnapshotSummary[]>(`/ranking-seasons/${season.id}/snapshots`)).data,
  });

  async function exportCsv(s: RankingSnapshotSummary) {
    setDownloading(s.snapshotId);
    try {
      await downloadFile(
        `/ranking-seasons/${season.id}/snapshots/${s.snapshotId}/export`,
        `ranking-${s.snapshotId.slice(0, 8)}.csv`,
      );
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '내보내지 못했습니다.');
    } finally {
      setDownloading(undefined);
    }
  }

  return (
    <>
      <Table<RankingSnapshotSummary>
        rowKey="snapshotId"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        pagination={false}
        scroll={{ x: 1000 }}
        locale={{ emptyText: <Empty description="초기화한 적이 없습니다" /> }}
        columns={[
          { title: '시각', dataIndex: 'createdAt', width: 150, render: fmtDateTime },
          {
            title: '종류',
            dataIndex: 'kind',
            width: 110,
            render: (k: string) =>
              k === 'BACKUP' ? (
                <Tooltip title="스냅샷을 복원하기 직전 순위를 자동으로 보관한 것 (이걸 복원하면 복원을 되돌림)">
                  <Tag color="blue">복원 전 보관</Tag>
                </Tooltip>
              ) : k === 'FINAL' ? (
                <Tooltip title="시즌 종료 시각에 자동으로 저장된 최종 순위">
                  <Tag color="gold">시즌 종료</Tag>
                </Tooltip>
              ) : (
                <Tag>초기화</Tag>
              ),
          },
          {
            title: '인원',
            dataIndex: 'count',
            width: 90,
            align: 'right',
            render: (n: number) => `${fmtNumber(n)}명`,
          },
          { title: '사유', dataIndex: 'reason', ellipsis: true },
          {
            title: '순위 보상',
            width: 150,
            render: (_, s) =>
              s.payout ? (
                <Tooltip
                  title={`${fmtDateTime(s.payout.createdAt)} · 제외 ${fmtNumber(s.payout.skippedCount)}명`}
                >
                  <Tag color="green">지급 완료 {fmtNumber(s.payout.recipientCount)}명</Tag>
                  {s.payout.mailIds[0] && <Link to={`/mails/${s.payout.mailIds[0]}`}>우편</Link>}
                </Tooltip>
              ) : (
                <Typography.Text type="secondary">-</Typography.Text>
              ),
          },
          {
            title: '',
            width: 330,
            render: (_, s) => (
              <Space size={4} wrap>
                <Button size="small" onClick={() => setViewing(s)}>
                  순위 보기
                </Button>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={downloading === s.snapshotId}
                  onClick={() => exportCsv(s)}
                >
                  CSV
                </Button>
                {canManage && s.kind !== 'BACKUP' && !s.payout && (
                  <Button size="small" icon={<GiftOutlined />} onClick={() => setRewarding(s)}>
                    보상 지급
                  </Button>
                )}
                {canManage && (
                  <Button
                    size="small"
                    danger
                    icon={<HistoryOutlined />}
                    onClick={() => setRestoring(s)}
                  >
                    복원
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Typography.Paragraph
        type="secondary"
        style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}
      >
        CSV 내보내기는 운영 로그에 남습니다. 보상 지급과 복원은 빨간 경고로 한 번 더 확인한 뒤
        실행되며, 웹에서만 할 수 있습니다.
      </Typography.Paragraph>

      <SnapshotDrawer
        seasonId={season.id}
        snapshot={viewing}
        onClose={() => setViewing(undefined)}
      />
      {rewarding && (
        <RewardModal season={season} snapshot={rewarding} onClose={() => setRewarding(undefined)} />
      )}
      {restoring && (
        <RestoreModal
          season={season}
          snapshot={restoring}
          onClose={() => setRestoring(undefined)}
        />
      )}
    </>
  );
}

function SnapshotDrawer({
  seasonId,
  snapshot,
  onClose,
}: {
  seasonId: number;
  snapshot?: RankingSnapshotSummary;
  onClose(): void;
}) {
  const [page, setPage] = useState(1);
  const rows = useQuery({
    queryKey: ['ranking', seasonId, 'snapshot', snapshot?.snapshotId, page],
    queryFn: async () =>
      (
        await api.get<SnapshotRow[]>(
          `/ranking-seasons/${seasonId}/snapshots/${snapshot!.snapshotId}`,
          {
            offset: (page - 1) * PAGE_SIZE,
            limit: PAGE_SIZE,
          },
        )
      ).data,
    enabled: !!snapshot,
    placeholderData: keepPreviousData,
  });

  return (
    <Drawer
      width={640}
      open={!!snapshot}
      onClose={() => {
        setPage(1);
        onClose();
      }}
      title={snapshot && `${fmtDateTime(snapshot.createdAt)} 스냅샷 순위`}
    >
      {snapshot && (
        <>
          <Typography.Paragraph type="secondary">사유: {snapshot.reason}</Typography.Paragraph>
          <Table<SnapshotRow>
            rowKey="rank"
            size="small"
            loading={rows.isFetching}
            dataSource={rows.data ?? []}
            columns={[
              {
                title: '순위',
                dataIndex: 'rank',
                width: 80,
                render: (r: number) =>
                  r <= 3 ? <b style={{ color: MEDAL[r - 1] }}>{r}</b> : fmtNumber(r),
              },
              {
                title: '회원',
                dataIndex: 'publicId',
                width: 140,
                render: (v: string) => (v ? <Link to={`/users/${v}`}>{v}</Link> : '-'),
              },
              { title: '닉네임', dataIndex: 'nickname' },
              { title: '점수', dataIndex: 'score', align: 'right', width: 140, render: fmtNumber },
            ]}
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              total: snapshot.count,
              showSizeChanger: false,
              onChange: setPage,
            }}
          />
        </>
      )}
    </Drawer>
  );
}

interface TierInput {
  fromRank?: number;
  toRank?: number;
  /** 마지막 순위까지 (끝 순위 입력 대신) */
  toEnd?: boolean;
  rewards: RewardInput[];
}

const endOf = (t: TierInput) => (t.toEnd ? Number.POSITIVE_INFINITY : (t.toRank ?? 0));
const isComplete = (t?: TierInput) => !!t?.fromRank && (t.toEnd || !!t.toRank);

interface RewardValues {
  title: string;
  body: string;
  expiresInDays: number;
  tiers: TierInput[];
  reason: string;
}

const DEFAULT_TIERS: TierInput[] = [
  { fromRank: 1, toRank: 1, rewards: [{ type: 'CURRENCY' }] },
  { fromRank: 2, toRank: 3, rewards: [{ type: 'CURRENCY' }] },
  { fromRank: 4, toRank: 10, rewards: [{ type: 'CURRENCY' }] },
  { fromRank: 11, toRank: 100, rewards: [{ type: 'CURRENCY' }] },
];

/** 구간별 보상 (L3) → 빨간 경고 확인 후 구간마다 우편 1통 */
function RewardModal({
  season,
  snapshot,
  onClose,
}: {
  season: RankingSeasonView;
  snapshot: RankingSnapshotSummary;
  onClose(): void;
}) {
  const [form] = Form.useForm<RewardValues>();
  const [loading, setLoading] = useState(false);
  const { modal, message } = App.useApp();
  const run = useSafeAction();
  const queryClient = useQueryClient();
  const tiers: TierInput[] = Form.useWatch('tiers', form) ?? [];

  // 구간별 실제 대상 수 (스냅샷 인원까지만, 탈퇴 회원은 실행 때 제외)
  const sizeOf = (t: TierInput) =>
    isComplete(t)
      ? tierSize({ fromRank: t.fromRank!, toRank: t.toEnd ? null : t.toRank! }, snapshot.count)
      : 0;
  const hasOpenEnd = tiers.some((t) => t?.toEnd);
  const total = tiers.reduce((n, t) => n + sizeOf(t), 0);

  /**
   * "마지막까지"는 맨 뒤 구간만 가능 → 중간 구간에서 체크하면 아래 구간을 지운다
   * 아래 구간에 입력한 내용이 있으면 먼저 확인, 취소하면 체크도 되돌림
   */
  function trimAfter(index: number, count: number, remove: (i: number[]) => void) {
    const below = Array.from({ length: count - index - 1 }, (_, k) => index + 1 + k);
    if (!below.length) return;
    const filled = below.some((i) => {
      const t = tiers[i];
      return !!(t?.fromRank || t?.toRank || t?.rewards?.some((r) => r?.code || r?.quantity));
    });
    if (!filled) {
      remove(below);
      return;
    }
    void modal.confirm({
      title: `아래 ${below.length}개 구간을 지울까요?`,
      content:
        '"마지막까지" 구간 뒤에는 다른 구간을 둘 수 없습니다. 아래 구간에 입력한 보상도 함께 지워집니다.',
      okText: '지우기',
      okButtonProps: { danger: true },
      cancelText: '취소',
      onOk: () => remove(below),
      onCancel: () => form.setFieldValue(['tiers', index, 'toEnd'], false),
    });
  }

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    const res = await run<{ recipientCount: number; skippedCount: number }>({
      request: ({ idempotencyKey, confirmationToken }) =>
        api.post(
          `/ranking-seasons/${season.id}/rewards`,
          {
            ...(confirmationToken ? { confirmationToken } : {}),
            snapshotId: snapshot.snapshotId,
            title: v.title,
            body: v.body,
            expiresInDays: v.expiresInDays,
            reason: v.reason,
            tiers: v.tiers.map((t) => ({
              fromRank: t.fromRank!,
              toRank: t.toEnd ? null : t.toRank!,
              rewards: t.rewards.map((r) => ({
                type: r.type,
                code: r.code!,
                quantity: r.quantity!,
              })),
            })),
          },
          { idempotencyKey },
        ),
      confirmTitle: '순위 보상 최종 확인',
    });
    setLoading(false);
    if (res) {
      void message.success(
        `${fmtNumber(res.data.recipientCount)}명에게 보상 우편을 보냈습니다${res.data.skippedCount ? ` (탈퇴 ${fmtNumber(res.data.skippedCount)}명 제외)` : ''}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['ranking', season.id, 'snapshots'] });
      onClose();
    }
  }

  return (
    <Modal
      open
      width={760}
      title={`순위 보상 우편 — ${season.name}`}
      onCancel={onClose}
      onOk={submit}
      okText="다음"
      okButtonProps={{ loading }}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`${fmtDateTime(snapshot.createdAt)} 스냅샷 (${fmtNumber(snapshot.count)}명) 기준으로 구간마다 우편 1통을 보냅니다`}
        description="다음 단계에서 대상 인원·보상을 한 번 더 확인한 뒤 바로 발송됩니다. 같은 스냅샷에는 한 번만 지급할 수 있고, 탈퇴한 회원은 제외됩니다."
      />
      <Form<RewardValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{
          title: `${season.name} 순위 보상`.slice(0, 38),
          body: `${season.name} 최종 순위 보상입니다. 참여해 주셔서 감사합니다.`,
          expiresInDays: 14,
          tiers: DEFAULT_TIERS,
        }}
      >
        <Row gutter={12}>
          <Col span={16}>
            <Form.Item
              name="title"
              label="우편 제목"
              rules={[{ required: true, whitespace: true }, { max: 38 }]}
              extra='실제 제목은 "제목 (1~3위)" 처럼 구간이 붙습니다'
            >
              <Input showCount maxLength={38} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="expiresInDays"
              label="유효기간"
              rules={[{ required: true, type: 'number', min: 1, max: 30 }]}
            >
              <InputNumber<number> min={1} max={30} addonAfter="일" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="body"
          label="본문"
          rules={[{ required: true, whitespace: true }, { max: 500 }]}
        >
          <Input.TextArea rows={2} showCount maxLength={500} />
        </Form.Item>

        <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
          <Typography.Text strong>순위 구간</Typography.Text>
          <Typography.Text type="secondary">
            스냅샷 {fmtNumber(snapshot.count)}명 중 대상 약 {fmtNumber(total)}명
          </Typography.Text>
        </Flex>
        {total > RANKING_REWARD_MAX_RECIPIENTS && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 8 }}
            message={`한 번에 ${fmtNumber(RANKING_REWARD_MAX_RECIPIENTS)}명까지 보낼 수 있습니다`}
            description="구간을 나눠 두 스냅샷에 보내는 대신, 순위 범위를 줄이거나 운영팀과 지급 방식을 다시 정하세요."
          />
        )}
        <Form.List
          name="tiers"
          rules={[
            {
              validator: async (_, list: TierInput[] = []) => {
                if (!list.length) throw new Error('구간을 하나 이상 넣으세요.');
                const sorted = list.filter(isComplete).sort((a, b) => a.fromRank! - b.fromRank!);
                for (let i = 1; i < sorted.length; i++) {
                  // "마지막까지" 구간 뒤에 다른 구간이 있으면 겹침으로 잡힌다
                  if (sorted[i]!.fromRank! <= endOf(sorted[i - 1]!))
                    throw new Error(`순위 구간이 겹칩니다 (${sorted[i]!.fromRank}위).`);
                }
              },
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field) => {
                const t = tiers[field.name];
                return (
                  <div
                    key={field.key}
                    style={{
                      border: '1px solid #f0f0f0',
                      borderRadius: 8,
                      padding: '12px 12px 4px',
                      marginBottom: 8,
                    }}
                  >
                    <Flex gap={8} align="start">
                      <Form.Item
                        name={[field.name, 'fromRank']}
                        rules={[{ required: true, message: '시작' }]}
                        style={{ marginBottom: 8 }}
                      >
                        <InputNumber<number> min={1} addonAfter="위" style={{ width: 120 }} />
                      </Form.Item>
                      <span style={{ lineHeight: '32px' }}>~</span>
                      <Form.Item
                        name={[field.name, 'toRank']}
                        dependencies={[
                          ['tiers', field.name, 'fromRank'],
                          ['tiers', field.name, 'toEnd'],
                        ]}
                        hidden={t?.toEnd}
                        rules={[
                          { required: !t?.toEnd, message: '끝' },
                          ({ getFieldValue }) => ({
                            validator: async (_, v?: number) => {
                              const from = getFieldValue(['tiers', field.name, 'fromRank']) as
                                number | undefined;
                              if (from && v && v < from) throw new Error('시작보다 작음');
                            },
                          }),
                        ]}
                        style={{ marginBottom: 8 }}
                      >
                        <InputNumber<number> min={1} addonAfter="위" style={{ width: 120 }} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'toEnd']}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Checkbox
                          style={{ lineHeight: '32px' }}
                          onChange={(e) => {
                            if (e.target.checked) trimAfter(field.name, fields.length, remove);
                          }}
                        >
                          마지막까지
                        </Checkbox>
                      </Form.Item>
                      <Typography.Text
                        type="secondary"
                        style={{ lineHeight: '32px', minWidth: 80 }}
                      >
                        {isComplete(t)
                          ? `${tierLabel({ fromRank: t!.fromRank!, toRank: t!.toEnd ? null : t!.toRank! })} · ${fmtNumber(sizeOf(t!))}명`
                          : ''}
                      </Typography.Text>
                      <Button
                        type="text"
                        icon={<DeleteOutlined />}
                        onClick={() => remove(field.name)}
                        style={{ marginLeft: 'auto' }}
                        aria-label="구간 삭제"
                      />
                    </Flex>
                    <RewardsEditor
                      name={[field.name, 'rewards']}
                      fullPath={['tiers', field.name, 'rewards']}
                    />
                  </div>
                );
              })}
              <Tooltip
                title={hasOpenEnd ? '"마지막까지" 구간 뒤에는 구간을 더할 수 없습니다' : undefined}
              >
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  disabled={fields.length >= RANKING_REWARD_MAX_TIERS || hasOpenEnd}
                  onClick={() => {
                    // 앞 구간 다음 순위부터, 기본은 "마지막까지" (나머지 전원 보상이 가장 흔함)
                    const last = tiers[tiers.length - 1];
                    add({
                      fromRank: (last?.toRank ?? 0) + 1,
                      toEnd: true,
                      rewards: [{ type: 'CURRENCY' }],
                    });
                  }}
                >
                  구간 추가 ({fields.length}/{RANKING_REWARD_MAX_TIERS})
                </Button>
              </Tooltip>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>
        <div style={{ height: 16 }} />
        <ReasonField />
      </Form>
    </Modal>
  );
}

/** 복원(교체, L3) → 빨간 경고 확인 후 실행. 현재 순위는 BACKUP 스냅샷으로 남고 이 스냅샷 순위로 바뀜 */
function RestoreModal({
  season,
  snapshot,
  onClose,
}: {
  season: RankingSeasonView;
  snapshot: RankingSnapshotSummary;
  onClose(): void;
}) {
  const [form] = Form.useForm<{ reason: string; agree: boolean }>();
  const [loading, setLoading] = useState(false);
  const run = useSafeAction();
  const queryClient = useQueryClient();

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    const res = await run({
      request: ({ idempotencyKey, confirmationToken }) =>
        api.post(
          `/ranking-seasons/${season.id}/restore`,
          {
            snapshotId: snapshot.snapshotId,
            reason: v.reason,
            ...(confirmationToken ? { confirmationToken } : {}),
          },
          { idempotencyKey },
        ),
      confirmTitle: '스냅샷 복원 최종 확인',
      successMessage: '복원했습니다. 바뀌기 전 순위는 "복원 전 보관" 스냅샷에 있습니다.',
    });
    setLoading(false);
    if (res) {
      void queryClient.invalidateQueries({ queryKey: ['ranking'] });
      onClose();
    }
  }

  return (
    <Modal
      open
      title={`스냅샷 복원 — ${season.name}`}
      onCancel={onClose}
      onOk={submit}
      okText="다음"
      okButtonProps={{ danger: true, loading }}
      destroyOnHidden
    >
      <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="스냅샷">
          {fmtDateTime(snapshot.createdAt)} · {fmtNumber(snapshot.count)}명
        </Descriptions.Item>
        <Descriptions.Item label="사유">{snapshot.reason}</Descriptions.Item>
      </Descriptions>
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        message="현재 순위가 통째로 이 스냅샷 내용으로 바뀝니다"
        description="스냅샷 이후에 새로 기록된 점수는 순위에서 사라집니다. 바뀌기 직전 순위는 '복원 전 보관' 스냅샷으로 자동 저장되어, 그걸 다시 복원하면 되돌릴 수 있습니다."
      />
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="agree"
          valuePropName="checked"
          rules={[
            {
              validator: async (_, v) =>
                v ? undefined : Promise.reject(new Error('확인이 필요합니다.')),
            },
          ]}
        >
          <Checkbox>현재 순위가 교체된다는 것을 확인했습니다</Checkbox>
        </Form.Item>
        <ReasonField />
      </Form>
    </Modal>
  );
}
