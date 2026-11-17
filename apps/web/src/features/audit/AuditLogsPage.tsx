import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { Permission, RoleCode, type AdminSummary, type AuditLogItem } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTION_LABEL,
  AUDIT_TARGET_LABEL,
  auditTargetPath,
} from '../../shared/audit-labels';
import { fmtDateTime } from '../../shared/format';

interface SearchValues {
  action?: string;
  targetType?: string;
  targetId?: string;
  adminId?: number;
  channel?: string;
  result?: string;
  range?: [Dayjs, Dayjs];
}

const FILTER_KEYS = [
  'action',
  'targetType',
  'targetId',
  'adminId',
  'channel',
  'result',
  'from',
  'to',
] as const;

const actionLabel = (a: string) => AUDIT_ACTION_LABEL[a as keyof typeof AUDIT_ACTION_LABEL] ?? a;
const targetLabel = (t: string | null) =>
  t ? (AUDIT_TARGET_LABEL[t as keyof typeof AUDIT_TARGET_LABEL] ?? t) : '';

function TargetCell({ type, id }: { type: string | null; id: string | null }) {
  if (!type) return <>-</>;
  const path = auditTargetPath(type, id);
  const text = `${targetLabel(type)} ${id ?? ''}`;
  return path ? (
    <Link to={path} onClick={(e) => e.stopPropagation()}>
      {text}
    </Link>
  ) : (
    <>{text}</>
  );
}

function ActorCell({ log }: { log: AuditLogItem }) {
  if (!log.admin)
    return (
      <Typography.Text type="secondary">
        {log.channel === 'SYSTEM' ? '시스템' : '-'}
      </Typography.Text>
    );
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {log.admin.name}
      {log.channel === 'MCP' && (
        <Tooltip title={log.apiTokenId ? `API 토큰 #${log.apiTokenId}` : undefined}>
          <Tag color="geekblue" style={{ marginLeft: 4 }}>
            MCP
          </Tag>
        </Tooltip>
      )}
      {log.channel === 'SYSTEM' && (
        <Tooltip title="워커(자동 작업)가 실행 — 시즌·점검 시작/종료 등">
          <Tag style={{ marginLeft: 4 }}>시스템</Tag>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * 운영 로그 (감사 로그) — 조회 전용. 검색 조건은 URL 에 저장
 * CS 역할은 서버가 본인 기록만 돌려준다
 */
export function AuditLogsPage() {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm<SearchValues>();
  const [selected, setSelected] = useState<AuditLogItem>();
  const { me, can } = useAuth();

  const filter = Object.fromEntries(
    FILTER_KEYS.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])),
  );

  const logs = useInfiniteQuery({
    queryKey: ['audit-logs', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<AuditLogItem[]>('/audit-logs', { ...filter, size: 50, cursor: pageParam }),
    getNextPageParam: (last) => (last.meta?.nextCursor as string | null | undefined) ?? undefined,
  });

  // 운영자 필터는 운영자 목록을 볼 수 있을 때만
  const admins = useQuery({
    queryKey: ['admins', 'all'],
    queryFn: async () => (await api.get<AdminSummary[]>('/admins', { size: 100 })).data,
    enabled: can(Permission.ADMIN_MANAGE),
    staleTime: 5 * 60_000,
  });

  function onSearch(v: SearchValues) {
    const next: Record<string, string> = {};
    if (v.action) next.action = v.action;
    if (v.targetType) next.targetType = v.targetType;
    if (v.targetId?.trim()) next.targetId = v.targetId.trim();
    if (v.adminId) next.adminId = String(v.adminId);
    if (v.channel) next.channel = v.channel;
    if (v.result) next.result = v.result;
    if (v.range) {
      next.from = v.range[0].startOf('day').toISOString();
      next.to = v.range[1].endOf('day').toISOString();
    }
    setParams(next);
  }

  const rows = logs.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="운영 로그"
        sub="운영자·MCP·시스템이 한 모든 변경과 민감 조회 기록 (수정·삭제 불가)"
      />
      {me?.roleCode === RoleCode.CS && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="고객지원 역할은 본인이 한 작업만 볼 수 있습니다."
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          style={{ rowGap: 8 }}
          initialValues={{
            action: filter.action,
            targetType: filter.targetType,
            targetId: filter.targetId,
            adminId: filter.adminId ? Number(filter.adminId) : undefined,
            channel: filter.channel,
            result: filter.result,
            range: filter.from && filter.to ? [dayjs(filter.from), dayjs(filter.to)] : undefined,
          }}
        >
          <Form.Item name="action">
            <Select
              placeholder="작업"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 180 }}
              options={AUDIT_ACTION_GROUPS.map((g) => ({
                label: g.label,
                options: g.actions.map((a) => ({ value: a, label: AUDIT_ACTION_LABEL[a] })),
              }))}
            />
          </Form.Item>
          <Form.Item name="targetType">
            <Select
              placeholder="대상 종류"
              allowClear
              style={{ width: 120 }}
              options={Object.entries(AUDIT_TARGET_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Form.Item>
          <Form.Item name="targetId">
            <Input placeholder="대상 ID" allowClear style={{ width: 130 }} />
          </Form.Item>
          {can(Permission.ADMIN_MANAGE) && (
            <Form.Item name="adminId">
              <Select
                placeholder="운영자"
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 140 }}
                loading={admins.isLoading}
                options={admins.data?.map((a) => ({ value: a.id, label: a.name }))}
              />
            </Form.Item>
          )}
          <Form.Item name="channel">
            <Select
              placeholder="채널"
              allowClear
              style={{ width: 100 }}
              options={[
                { value: 'WEB', label: '웹' },
                { value: 'MCP', label: 'MCP' },
                { value: 'SYSTEM', label: '시스템' },
              ]}
            />
          </Form.Item>
          <Form.Item name="result">
            <Select
              placeholder="결과"
              allowClear
              style={{ width: 100 }}
              options={[
                { value: 'SUCCESS', label: '성공' },
                { value: 'FAILURE', label: '실패' },
              ]}
            />
          </Form.Item>
          <Form.Item name="range">
            <DatePicker.RangePicker />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
            검색
          </Button>
          <Button
            style={{ marginLeft: 8 }}
            onClick={() => {
              form.setFieldsValue({
                action: undefined,
                targetType: undefined,
                targetId: undefined,
                adminId: undefined,
                channel: undefined,
                result: undefined,
                range: undefined,
              });
              setParams({});
            }}
          >
            초기화
          </Button>
        </Form>
      </Card>

      <Card>
        <Table<AuditLogItem>
          rowKey="id"
          size="small"
          loading={logs.isLoading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1000 }}
          onRow={(r) => ({ onClick: () => setSelected(r), style: { cursor: 'pointer' } })}
          locale={{ emptyText: <Empty description="기록이 없습니다" /> }}
          columns={[
            {
              title: '시각',
              dataIndex: 'createdAt',
              width: 150,
              render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
            },
            { title: '운영자', width: 150, render: (_, r) => <ActorCell log={r} /> },
            { title: '작업', dataIndex: 'action', width: 150, render: actionLabel },
            {
              title: '대상',
              width: 170,
              render: (_, r) => <TargetCell type={r.targetType} id={r.targetId} />,
            },
            {
              title: '사유',
              dataIndex: 'reason',
              ellipsis: true,
              render: (v: string | null) => v ?? '-',
            },
            {
              title: '결과',
              dataIndex: 'result',
              width: 90,
              render: (v: string, r) =>
                v === 'SUCCESS' ? (
                  <Tag color="green">성공</Tag>
                ) : (
                  <Tooltip title={r.errorCode}>
                    <Tag color="red">실패</Tag>
                  </Tooltip>
                ),
            },
          ]}
        />
        {logs.hasNextPage && (
          <Button
            block
            style={{ marginTop: 12 }}
            loading={logs.isFetchingNextPage}
            onClick={() => logs.fetchNextPage()}
          >
            더 보기
          </Button>
        )}
      </Card>

      <Drawer
        width={640}
        open={!!selected}
        onClose={() => setSelected(undefined)}
        title={selected && `#${selected.id} ${actionLabel(selected.action)}`}
      >
        {selected && <AuditDetail log={selected} />}
      </Drawer>
    </>
  );
}

/** 변경 전후 비교: 최상위 키 기준으로 나란히, 바뀐 값은 강조 */
function ChangeTable({ before, after }: { before: unknown; after: unknown }) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(b) || !isObj(a)) {
    return <pre style={{ fontSize: 12 }}>{JSON.stringify({ before, after }, null, 2)}</pre>;
  }
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (!keys.length) return <Typography.Text type="secondary">변경 데이터 없음</Typography.Text>;
  const show = (v: unknown) =>
    v === undefined ? (
      <Typography.Text type="secondary">-</Typography.Text>
    ) : typeof v === 'object' ? (
      <code>{JSON.stringify(v)}</code>
    ) : (
      String(v)
    );
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="key"
      dataSource={keys.map((key) => ({
        key,
        before: b[key],
        after: a[key],
        changed: JSON.stringify(b[key]) !== JSON.stringify(a[key]),
      }))}
      columns={[
        { title: '항목', dataIndex: 'key', width: 150 },
        { title: '변경 전', dataIndex: 'before', render: show },
        {
          title: '변경 후',
          dataIndex: 'after',
          render: (v: unknown, r: { changed: boolean }) =>
            r.changed ? <b style={{ color: '#2a78d6' }}>{show(v)}</b> : show(v),
        },
      ]}
    />
  );
}

function AuditDetail({ log }: { log: AuditLogItem }) {
  return (
    <>
      <Descriptions
        column={1}
        size="small"
        bordered
        styles={{ label: { width: 110 } }}
        style={{ marginBottom: 16 }}
      >
        <Descriptions.Item label="시각">{fmtDateTime(log.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="운영자">
          <ActorCell log={log} />
        </Descriptions.Item>
        <Descriptions.Item label="채널">{log.channel}</Descriptions.Item>
        <Descriptions.Item label="대상">
          <TargetCell type={log.targetType} id={log.targetId} />
        </Descriptions.Item>
        <Descriptions.Item label="사유">{log.reason ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="결과">
          {log.result === 'SUCCESS' ? (
            <Tag color="green">성공</Tag>
          ) : (
            <Tag color="red">실패 {log.errorCode}</Tag>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="요청 ID">
          {log.requestId ? <Typography.Text copyable>{log.requestId}</Typography.Text> : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="IP">{log.ip ?? '-'}</Descriptions.Item>
      </Descriptions>
      <Typography.Title level={5}>변경 내용</Typography.Title>
      <ChangeTable before={log.before} after={log.after} />
    </>
  );
}
