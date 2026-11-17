import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Result,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  EyeOutlined,
  MailOutlined,
  StopOutlined,
  SwapOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Permission,
  type UserActivity,
  type UserDetail,
  type UserMailboxItem,
  type UserSuspension,
} from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { Can } from '../../shared/auth/guards';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { UserStatusTag } from '../../shared/components/StatusTag';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { SuspendModal, UnsuspendModal } from './SuspendModals';
import { CurrencyChangeModal } from '../currencies/CurrencyChangeModal';
import { CurrencyLedgerTable } from '../currencies/CurrencyLedgerTable';
import { currencyLabel, useCurrencies } from '../currencies/common';
import { MAIL_TYPE_LABEL, MailStatusTag, RewardTags } from '../mails/common';

const ACTIVITY_LABEL: Record<string, string> = {
  LOGIN: '로그인',
  LOGOUT: '로그아웃',
  STAGE_CLEAR: '스테이지 클리어',
  ITEM_USE: '아이템 사용',
  CURRENCY_EARN: '재화 획득',
  CURRENCY_SPEND: '재화 사용',
  MAIL_CLAIM: '우편 수령',
};

export function UserDetailPage() {
  const { publicId = '' } = useParams();
  const { modal } = App.useApp();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'suspend' | 'unsuspend' | 'currency' | null>(null);

  const detail = useQuery({
    queryKey: ['user', publicId],
    queryFn: async () => (await api.get<UserDetail>(`/users/${publicId}`)).data,
  });
  const suspensions = useQuery({
    queryKey: ['user', publicId, 'suspensions'],
    queryFn: async () => (await api.get<UserSuspension[]>(`/users/${publicId}/suspensions`)).data,
  });
  const activities = useInfiniteQuery({
    queryKey: ['user', publicId, 'activities'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      api.get<UserActivity[]>(`/users/${publicId}/activities`, { size: 20, cursor: pageParam }),
    getNextPageParam: (last) => (last.meta?.nextCursor as string | null | undefined) ?? undefined,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['user', publicId] });
  const { can } = useAuth();
  const currencies = useCurrencies();
  const navigate = useNavigate();
  const mailbox = useQuery({
    queryKey: ['user', publicId, 'mailbox'],
    queryFn: async () => (await api.get<UserMailboxItem[]>(`/users/${publicId}/mails`)).data,
    enabled: can(Permission.MAIL_READ),
  });

  /** 개인정보 원문 — 열람 자체가 감사 로그에 남는다는 걸 먼저 알린다 */
  async function showPii() {
    const ok = await modal.confirm({
      title: '개인정보 열람',
      content:
        '열람 기록(운영자·시각·대상)이 운영 로그에 남습니다. 업무상 필요한 경우에만 열람하세요.',
      okText: '열람',
    });
    if (!ok) return;
    try {
      const { data } = await api.get<{ email: string }>(`/users/${publicId}/pii`);
      modal.info({ title: '이메일', content: data.email });
    } catch (err) {
      modal.error({
        title: '열람 실패',
        content: err instanceof ApiError ? err.message : '오류가 발생했습니다.',
      });
    }
  }

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return <Result status="404" title="회원을 찾을 수 없습니다" subTitle={publicId} />;
  }
  const u = detail.data;

  return (
    <>
      <PageHeader
        title={u ? `${u.nickname}` : publicId}
        sub={publicId}
        extra={
          u && (
            <Space>
              {u.status !== 'WITHDRAWN' && (
                <Can permissions={[Permission.MAIL_SEND]}>
                  <Button
                    icon={<MailOutlined />}
                    onClick={() => navigate(`/mails/new?to=${encodeURIComponent(publicId)}`)}
                  >
                    우편 보내기
                  </Button>
                </Can>
              )}
              <Can permissions={[Permission.USER_SUSPEND]}>
                {u.status === 'SUSPENDED' ? (
                  <Button icon={<UndoOutlined />} onClick={() => setDialog('unsuspend')}>
                    정지 해제
                  </Button>
                ) : u.status === 'ACTIVE' ? (
                  <Button danger icon={<StopOutlined />} onClick={() => setDialog('suspend')}>
                    정지
                  </Button>
                ) : null}
              </Can>
            </Space>
          )
        }
      />

      {u?.activeSuspension && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            u.activeSuspension.endsAt
              ? `정지 중 — ${fmtDateTime(u.activeSuspension.endsAt)} 까지`
              : '영구 정지 중'
          }
          description={`사유: ${u.activeSuspension.reason} · 시작: ${fmtDateTime(u.activeSuspension.startsAt)}`}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="기본 정보">
            <Skeleton loading={detail.isLoading} active>
              {u && (
                <Descriptions
                  bordered
                  size="small"
                  // 화면 크기와 관계없이 2열 (지정하지 않은 크기는 antd 기본 3열이 되어 칸이 좁아짐)
                  column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2, xxl: 2 }}
                  styles={{ label: { width: 96, whiteSpace: 'nowrap' } }}
                >
                  <Descriptions.Item label="상태">
                    <UserStatusTag status={u.status} />
                  </Descriptions.Item>
                  <Descriptions.Item label="레벨">{u.level}</Descriptions.Item>
                  <Descriptions.Item label="가입일">
                    {fmtDateTime(u.registeredAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="최근 접속">
                    {fmtDateTime(u.lastLoginAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="이메일" span={2}>
                    <Typography.Text style={{ whiteSpace: 'nowrap' }}>{u.email}</Typography.Text>
                    <Can permissions={[Permission.USER_READ_PII]}>
                      <Button size="small" type="link" icon={<EyeOutlined />} onClick={showPii}>
                        원문 보기
                      </Button>
                    </Can>
                  </Descriptions.Item>
                </Descriptions>
              )}
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            title="보유 재화"
            extra={
              u &&
              u.status !== 'WITHDRAWN' &&
              (can(Permission.CURRENCY_GRANT) || can(Permission.CURRENCY_DEDUCT)) && (
                <Button size="small" icon={<SwapOutlined />} onClick={() => setDialog('currency')}>
                  지급·회수
                </Button>
              )
            }
          >
            <Skeleton loading={detail.isLoading} active paragraph={{ rows: 1 }}>
              <Row gutter={16}>
                {u?.balances.map((b) => (
                  <Col xs={12} sm={6} xl={12} key={b.currencyCode} style={{ marginBottom: 8 }}>
                    <Statistic
                      title={currencyLabel(currencies.data, b.currencyCode)}
                      value={b.balance}
                      formatter={(v) => fmtNumber(Number(v))}
                    />
                  </Col>
                ))}
              </Row>
            </Skeleton>
          </Card>
        </Col>
      </Row>

      <Card style={{ marginTop: 16 }}>
        <Tabs
          items={[
            {
              key: 'activities',
              label: '활동 이력',
              children: (
                <>
                  <Table<UserActivity>
                    rowKey="id"
                    size="small"
                    loading={activities.isLoading}
                    pagination={false}
                    dataSource={activities.data?.pages.flatMap((p) => p.data) ?? []}
                    locale={{ emptyText: <Empty description="활동 이력이 없습니다" /> }}
                    columns={[
                      { title: '시각', dataIndex: 'occurredAt', width: 180, render: fmtDateTime },
                      {
                        title: '유형',
                        dataIndex: 'type',
                        width: 140,
                        render: (t: string) => ACTIVITY_LABEL[t] ?? t,
                      },
                      {
                        title: '내용',
                        dataIndex: 'payload',
                        render: (p: Record<string, unknown> | null) =>
                          p
                            ? Object.entries(p)
                                .map(([k, v]) => `${k}: ${String(v)}`)
                                .join(' · ')
                            : '-',
                      },
                    ]}
                  />
                  {activities.hasNextPage && (
                    <Button
                      block
                      style={{ marginTop: 12 }}
                      loading={activities.isFetchingNextPage}
                      onClick={() => activities.fetchNextPage()}
                    >
                      더 보기
                    </Button>
                  )}
                </>
              ),
            },
            ...(can(Permission.CURRENCY_READ)
              ? [
                  {
                    key: 'currency',
                    label: '재화 원장',
                    children: <CurrencyLedgerTable filter={{ publicId }} showUser={false} />,
                  },
                ]
              : []),
            ...(can(Permission.MAIL_READ)
              ? [
                  {
                    key: 'mailbox',
                    label: '우편함',
                    children: (
                      <Table<UserMailboxItem>
                        rowKey="mailId"
                        size="small"
                        loading={mailbox.isLoading}
                        pagination={false}
                        dataSource={mailbox.data ?? []}
                        locale={{ emptyText: <Empty description="받은 우편이 없습니다" /> }}
                        footer={() =>
                          '최근 개별 우편 50건과 받을 수 있는 전체 우편 50건까지 표시합니다.'
                        }
                        columns={[
                          {
                            title: '우편',
                            dataIndex: 'title',
                            render: (v: string, r) => (
                              <Link to={`/mails/${r.mailId}`}>
                                #{r.mailId} {v}
                              </Link>
                            ),
                          },
                          {
                            title: '유형',
                            dataIndex: 'type',
                            width: 70,
                            render: (t: UserMailboxItem['type']) => MAIL_TYPE_LABEL[t],
                          },
                          {
                            title: '보상',
                            width: 260,
                            render: (_, r) => <RewardTags rewards={r.rewards} />,
                          },
                          {
                            title: '상태',
                            width: 70,
                            render: (_, r) => (
                              <MailStatusTag status={r.status} expiresAt={r.expiresAt} />
                            ),
                          },
                          {
                            title: '만료',
                            dataIndex: 'expiresAt',
                            width: 150,
                            render: fmtDateTime,
                          },
                          {
                            title: '수령',
                            dataIndex: 'claimedAt',
                            width: 150,
                            render: (v: string | null) => (v ? fmtDateTime(v) : <Tag>미수령</Tag>),
                          },
                        ]}
                      />
                    ),
                  },
                ]
              : []),
            {
              key: 'suspensions',
              label: '정지 이력',
              children: (
                <Table<UserSuspension>
                  rowKey="id"
                  size="small"
                  loading={suspensions.isLoading}
                  pagination={false}
                  dataSource={suspensions.data ?? []}
                  locale={{ emptyText: <Empty description="정지 이력이 없습니다" /> }}
                  columns={[
                    { title: '시작', dataIndex: 'startsAt', render: fmtDateTime },
                    {
                      title: '종료 예정',
                      dataIndex: 'endsAt',
                      render: (v: string | null) => (v ? fmtDateTime(v) : '영구'),
                    },
                    { title: '사유', dataIndex: 'reason' },
                    { title: '해제', dataIndex: 'releasedAt', render: fmtDateTime },
                    {
                      title: '해제 사유',
                      dataIndex: 'releaseReason',
                      render: (v: string | null) => v ?? '-',
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      <SuspendModal
        publicId={publicId}
        open={dialog === 'suspend'}
        onClose={() => setDialog(null)}
        onDone={refresh}
      />
      <UnsuspendModal
        publicId={publicId}
        open={dialog === 'unsuspend'}
        onClose={() => setDialog(null)}
        onDone={refresh}
      />
      <CurrencyChangeModal
        publicId={publicId}
        open={dialog === 'currency'}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
