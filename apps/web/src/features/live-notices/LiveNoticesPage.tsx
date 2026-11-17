import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, PushpinFilled, ThunderboltOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import {
  Permission,
  type MaintenanceView,
  type NoticeCategory,
  type NoticeView,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import {
  CATEGORY_LABEL,
  CategoryTag,
  MaintenanceStatusTag,
  NoticeStatusTag,
  fmt,
  fmtRange,
  remain,
  useCurrentMaintenance,
} from './common';
import { MaintenanceEditor, type EditorMode } from './MaintenanceEditor';
import { NoticeEditor } from './NoticeEditor';

type Tab = 'maintenance' | 'notice';

/** 점검·공지 (docs/maintenance-notice.md 7장). 탭·페이지·포커스는 URL */
export function LiveNoticesPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'notice' ? 'notice' : 'maintenance';
  const set = (patch: Record<string, string | undefined>) => {
    const next = Object.fromEntries(params.entries());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title="점검·공지"
        sub="게임 점검으로 접속을 막고, 게임 공지와 로비 한 줄 공지를 관리합니다"
      />
      <Tabs
        activeKey={tab}
        onChange={(k) => setParams({ tab: k })}
        items={[
          {
            key: 'maintenance',
            label: '점검',
            children: <MaintenanceTab params={params} set={set} />,
          },
          { key: 'notice', label: '공지', children: <NoticeTab params={params} set={set} /> },
        ]}
      />
    </>
  );
}

interface TabProps {
  params: URLSearchParams;
  set(patch: Record<string, string | undefined>): void;
}

function MaintenanceTab({ params, set }: TabProps) {
  const { can } = useAuth();
  const manage = can(Permission.MAINTENANCE_MANAGE);
  const page = Number(params.get('page') ?? 1) || 1;
  const [editing, setEditing] = useState<{ m?: MaintenanceView; mode?: EditorMode } | null>(null);
  const current = useCurrentMaintenance();
  const list = useQuery({
    queryKey: ['maintenances', page],
    queryFn: () => api.get<MaintenanceView[]>('/maintenances', { page, size: 20 }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = list.data?.data ?? [];
  const now = current.data;
  const activeRow = now?.active ? rows.find((r) => r.id === now.maintenanceId) : undefined;
  const upcoming = rows
    .filter((r) => r.status === 'SCHEDULED')
    .sort((a, b) => dayjs(a.startsAt).valueOf() - dayjs(b.startsAt).valueOf())[0];

  // 운영 로그에서 "점검 #id" 로 들어오면 연다
  const focus = Number(params.get('focus'));
  useEffect(() => {
    if (!focus) return;
    void api.get<MaintenanceView>(`/maintenances/${focus}`).then(({ data }) => {
      setEditing({ m: data });
      set({ focus: undefined });
    });
  }, [focus]); // focus 가 바뀔 때만

  return (
    <>
      <Card
        style={{
          marginBottom: 16,
          borderColor: now?.active ? '#ff4d4f' : undefined,
          background: now?.active ? '#fff1f0' : undefined,
        }}
      >
        <Flex justify="space-between" align="center" wrap gap={12}>
          {now?.active ? (
            <Space direction="vertical" size={2}>
              <Space>
                <Tag color="red">점검 중</Tag>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {now.title}
                </Typography.Text>
              </Space>
              <Typography.Text>
                ~{fmt(now.endsAt)} ({remain(now.endsAt!)} 남음) · 게임 접속 차단 중 · 세션 세대{' '}
                {now.sessionEpoch}
              </Typography.Text>
              {activeRow && (
                <Typography.Text type="secondary">
                  예외 회원 {activeRow.allowPublicIds.length}명
                  {activeRow.allowPublicIds.length
                    ? ` (${activeRow.allowPublicIds.slice(0, 5).join(', ')}${activeRow.allowPublicIds.length > 5 ? ' …' : ''})`
                    : ''}
                </Typography.Text>
              )}
            </Space>
          ) : (
            <Space direction="vertical" size={2}>
              <Space>
                <Tag color="green">정상 운영</Tag>
                <Typography.Text>게임 접속 가능</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {upcoming
                  ? `다음 점검: ${upcoming.title} · ${fmtRange(upcoming.startsAt, upcoming.endsAt)}`
                  : '예정된 점검이 없습니다'}
              </Typography.Text>
            </Space>
          )}
          {manage && (
            <Space wrap>
              {now?.active ? (
                activeRow && (
                  <Button onClick={() => setEditing({ m: activeRow })}>연장 · 지금 열기</Button>
                )
              ) : (
                <>
                  <Button icon={<PlusOutlined />} onClick={() => setEditing({ mode: 'schedule' })}>
                    점검 예약
                  </Button>
                  <Button
                    type="primary"
                    danger
                    icon={<ThunderboltOutlined />}
                    onClick={() => setEditing({ mode: 'emergency' })}
                  >
                    긴급 점검
                  </Button>
                </>
              )}
            </Space>
          )}
        </Flex>
      </Card>

      <Card title="점검 목록">
        <Table<MaintenanceView>
          rowKey="id"
          size="small"
          loading={list.isLoading}
          dataSource={rows}
          scroll={{ x: 900 }}
          onRow={(r) => ({ onClick: () => setEditing({ m: r }), style: { cursor: 'pointer' } })}
          pagination={{
            current: page,
            pageSize: 20,
            total: list.data?.meta?.total ?? 0,
            onChange: (p) => set({ page: String(p) }),
            showSizeChanger: false,
          }}
          locale={{ emptyText: <Empty description="점검 기록이 없습니다" /> }}
          columns={[
            {
              title: '상태',
              dataIndex: 'status',
              width: 90,
              render: (s: MaintenanceView['status']) => <MaintenanceStatusTag status={s} />,
            },
            { title: '제목', dataIndex: 'title', ellipsis: true },
            {
              title: '기간',
              width: 300,
              render: (_, r) => (
                <>
                  {fmtRange(r.startsAt, r.endsAt)}
                  {r.endedAt && (
                    <Typography.Text type="secondary">
                      {' '}
                      (일찍 엶 {dayjs(r.endedAt).format('HH:mm')})
                    </Typography.Text>
                  )}
                </>
              ),
            },
            {
              title: '예외 회원',
              width: 90,
              align: 'right',
              render: (_, r) => r.allowPublicIds.length || '-',
            },
            {
              title: '공지',
              width: 80,
              render: (_, r) => (r.notice ? `#${r.notice.id}` : '-'),
            },
            { title: '등록', width: 100, render: (_, r) => r.createdBy.name },
          ]}
        />
      </Card>

      <MaintenanceEditor
        open={editing !== null}
        maintenance={editing?.m}
        mode={editing?.mode}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

type CategoryFilter = 'ALL' | NoticeCategory;

function NoticeTab({ params, set }: TabProps) {
  const { can } = useAuth();
  const page = Number(params.get('page') ?? 1) || 1;
  const category = (params.get('category') as CategoryFilter | null) ?? 'ALL';
  const includeHidden = params.get('hidden') === 'true';
  const [editing, setEditing] = useState<{ n?: NoticeView } | null>(null);
  const list = useQuery({
    queryKey: ['notices', page, category, includeHidden],
    queryFn: () =>
      api.get<NoticeView[]>('/notices', {
        page,
        size: 20,
        ...(category === 'ALL' ? {} : { category }),
        ...(includeHidden ? { includeHidden: 'true' } : {}),
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const focus = Number(params.get('focus'));
  useEffect(() => {
    if (!focus) return;
    void api.get<NoticeView>(`/notices/${focus}`).then(({ data }) => {
      setEditing({ n: data });
      set({ focus: undefined });
    });
  }, [focus]); // focus 가 바뀔 때만

  return (
    <>
      <Card>
        <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
          <Space wrap>
            <Select<CategoryFilter>
              value={category}
              style={{ width: 140 }}
              onChange={(v) => set({ category: v === 'ALL' ? undefined : v, page: undefined })}
              options={[
                { value: 'ALL', label: '전체 분류' },
                ...(Object.keys(CATEGORY_LABEL) as NoticeCategory[]).map((k) => ({
                  value: k,
                  label: CATEGORY_LABEL[k],
                })),
              ]}
            />
            <Space size={4}>
              <Switch
                size="small"
                checked={includeHidden}
                onChange={(v) => set({ hidden: v ? 'true' : undefined, page: undefined })}
              />
              <Typography.Text type="secondary">내린 공지 포함</Typography.Text>
            </Space>
          </Space>
          {can(Permission.NOTICE_MANAGE) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({})}>
              공지 등록
            </Button>
          )}
        </Flex>
        <Table<NoticeView>
          rowKey="id"
          size="small"
          loading={list.isLoading}
          dataSource={list.data?.data ?? []}
          scroll={{ x: 900 }}
          onRow={(r) => ({ onClick: () => setEditing({ n: r }), style: { cursor: 'pointer' } })}
          pagination={{
            current: page,
            pageSize: 20,
            total: list.data?.meta?.total ?? 0,
            onChange: (p) => set({ page: String(p) }),
            showSizeChanger: false,
          }}
          locale={{ emptyText: <Empty description="공지가 없습니다" /> }}
          expandable={{
            expandedRowRender: (r) => (
              <Descriptions column={1} size="small">
                <Descriptions.Item label="본문">
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                    {r.body}
                  </Typography.Paragraph>
                </Descriptions.Item>
                {r.tickerEnabled && (
                  <Descriptions.Item label="한 줄 공지">{r.tickerText}</Descriptions.Item>
                )}
              </Descriptions>
            ),
          }}
          columns={[
            {
              title: '분류',
              dataIndex: 'category',
              width: 90,
              render: (c: NoticeCategory) => <CategoryTag category={c} />,
            },
            {
              title: '제목',
              ellipsis: true,
              render: (_, r) => (
                <Space size={4}>
                  {r.pinned && <PushpinFilled style={{ color: '#cf1322' }} />}
                  {r.title}
                </Space>
              ),
            },
            { title: '게시 기간', width: 300, render: (_, r) => fmtRange(r.startsAt, r.endsAt) },
            {
              title: '한 줄',
              width: 70,
              render: (_, r) => (r.tickerEnabled ? <Tag color="purple">티커</Tag> : '-'),
            },
            {
              title: '상태',
              dataIndex: 'status',
              width: 100,
              render: (s: NoticeView['status']) => <NoticeStatusTag status={s} />,
            },
          ]}
        />
      </Card>
      <NoticeEditor open={editing !== null} notice={editing?.n} onClose={() => setEditing(null)} />
    </>
  );
}
