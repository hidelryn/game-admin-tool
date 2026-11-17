import { useState } from 'react';
import {
  Card,
  Col,
  Flex,
  Row,
  Segmented,
  Select,
  Skeleton,
  Statistic,
  Switch,
  Table,
  Typography,
} from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import dayjs from 'dayjs';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Permission,
  type CurrencyFlow,
  type CurrencyInfo,
  type DashboardSummary,
  type TrendPoint,
} from '@game-admin/shared';
import { useCurrentMaintenance } from '../live-notices/common';
import { useAuth } from '../../shared/auth/AuthProvider';
import { api } from '../../shared/api/client';
import { PageHeader } from '../../shared/components/PageHeader';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { AXIS_TEXT, GRID, SERIES } from '../../shared/charts/palette';

type Metric = 'dau' | 'nru' | 'suspendedTotal';
const METRIC_LABEL: Record<Metric, string> = {
  dau: 'DAU',
  nru: '신규 가입',
  suspendedTotal: '정지 회원',
};

const shortDate = (d: string) => d.slice(5).replace('-', '/');

/** 어제 대비 변화 — 색 대신 화살표 + 숫자로 */
function Delta({ today, yesterday }: { today: number; yesterday: number | undefined }) {
  if (yesterday === undefined) return null;
  const diff = today - yesterday;
  const icon =
    diff > 0 ? <ArrowUpOutlined /> : diff < 0 ? <ArrowDownOutlined /> : <MinusOutlined />;
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {icon} 어제 {fmtNumber(yesterday)} 대비 {diff > 0 ? '+' : ''}
      {fmtNumber(diff)}
    </Typography.Text>
  );
}

export function DashboardPage() {
  const [metric, setMetric] = useState<Metric>('dau');
  const [currency, setCurrency] = useState('GOLD');
  const [asTable, setAsTable] = useState(false);

  const { can } = useAuth();
  const maintenance = useCurrentMaintenance();
  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => (await api.get<DashboardSummary>('/dashboard/summary')).data,
    refetchInterval: 60_000,
  });
  const trends = useQuery({
    queryKey: ['dashboard', 'trends', metric],
    queryFn: async () => (await api.get<TrendPoint[]>('/dashboard/trends', { metric })).data,
    refetchInterval: 60_000, // 오늘 값은 실시간 계산 → 카드와 같은 주기로 갱신
  });
  const currencies = useQuery({
    queryKey: ['currencies'],
    queryFn: async () => (await api.get<CurrencyInfo[]>('/currencies')).data,
    retry: false,
  });
  const flows = useQuery({
    queryKey: ['dashboard', 'flows', currency],
    queryFn: async () =>
      (await api.get<CurrencyFlow[]>('/dashboard/currency-flows', { currencyCode: currency })).data,
    refetchInterval: 60_000,
  });

  const s = summary.data;

  return (
    <>
      <PageHeader
        title="대시보드"
        sub={
          s
            ? `오늘(KST) 기준 · ${fmtDateTime(s.generatedAt)} 갱신 · 1분마다 자동 새로고침`
            : undefined
        }
        extra={
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary">표로 보기</Typography.Text>
            <Switch size="small" checked={asTable} onChange={setAsTable} />
          </Flex>
        }
      />

      <Row gutter={[16, 16]}>
        {(
          [
            ['DAU', s?.today.dau, s?.yesterday?.dau],
            ['신규 가입', s?.today.nru, s?.yesterday?.nru],
            ['정지 회원', s?.today.suspendedTotal, s?.yesterday?.suspendedTotal],
          ] as const
        ).map(([title, today, yesterday]) => (
          <Col xs={12} lg={6} key={title}>
            <Card>
              <Skeleton loading={summary.isLoading} active paragraph={{ rows: 1 }}>
                <Statistic
                  title={title}
                  value={today ?? 0}
                  formatter={(v) => fmtNumber(Number(v))}
                />
                <Delta today={today ?? 0} yesterday={yesterday} />
              </Skeleton>
            </Card>
          </Col>
        ))}
        <Col xs={12} lg={6}>
          <Card>
            <Skeleton loading={maintenance.isLoading} active paragraph={{ rows: 1 }}>
              <Statistic
                title="게임 상태"
                value={maintenance.data?.active ? '점검 중' : '정상 운영'}
                valueStyle={{ color: maintenance.data?.active ? '#cf1322' : undefined }}
              />
              {can(Permission.NOTICE_READ) && (
                <Link to="/live-notices?tab=maintenance" style={{ fontSize: 12 }}>
                  {maintenance.data?.active && maintenance.data.endsAt
                    ? `~${dayjs(maintenance.data.endsAt).format('MM/DD HH:mm')} · 점검 보기`
                    : '점검·공지로'}
                </Link>
              )}
            </Skeleton>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={14}>
          <Card
            title={`${METRIC_LABEL[metric]} 추이 (최근 30일)`}
            extra={
              <Segmented
                size="small"
                value={metric}
                onChange={(v) => setMetric(v as Metric)}
                options={Object.entries(METRIC_LABEL).map(([value, label]) => ({ value, label }))}
              />
            }
          >
            {trends.isLoading ? (
              <Skeleton active />
            ) : asTable ? (
              <Table
                size="small"
                rowKey="date"
                pagination={{ pageSize: 10 }}
                dataSource={[...(trends.data ?? [])].reverse()}
                columns={[
                  { title: '날짜', dataIndex: 'date' },
                  {
                    title: METRIC_LABEL[metric],
                    dataIndex: 'value',
                    align: 'right',
                    render: fmtNumber,
                  },
                ]}
              />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={trends.data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    allowDecimals={false}
                    tickFormatter={(v: unknown) => fmtNumber(Number(v))}
                  />
                  <Tooltip
                    formatter={(v: unknown) => [fmtNumber(Number(v)), METRIC_LABEL[metric]]}
                    labelFormatter={(d: unknown) => String(d)}
                    cursor={{ stroke: GRID, strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={SERIES[0]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card
            title="재화 발행·소모 (최근 30일)"
            extra={
              <Select
                size="small"
                value={currency}
                onChange={setCurrency}
                style={{ width: 120 }}
                options={(currencies.data ?? [{ code: 'GOLD', name: '골드' }]).map((c) => ({
                  value: c.code,
                  label: c.name,
                }))}
              />
            }
          >
            {flows.isLoading ? (
              <Skeleton active />
            ) : asTable ? (
              <Table
                size="small"
                rowKey="date"
                pagination={{ pageSize: 10 }}
                dataSource={[...(flows.data ?? [])].reverse()}
                columns={[
                  { title: '날짜', dataIndex: 'date' },
                  { title: '발행', dataIndex: 'issued', align: 'right', render: fmtNumber },
                  { title: '소모', dataIndex: 'consumed', align: 'right', render: fmtNumber },
                ]}
              />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={flows.data}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                  barGap={2}
                  barCategoryGap="20%"
                >
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tickFormatter={(v: unknown) => fmtNumber(Number(v))}
                  />
                  <Tooltip
                    formatter={(v: unknown, name: unknown) => [fmtNumber(Number(v)), String(name)]}
                    labelFormatter={(d: unknown) => String(d)}
                    cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: AXIS_TEXT }} />
                  <Bar
                    dataKey="issued"
                    name="발행"
                    fill={SERIES[0]}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={14}
                  />
                  <Bar
                    dataKey="consumed"
                    name="소모"
                    fill={SERIES[1]}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={14}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
      </Row>

      <Card title="오늘 재화 흐름" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="currencyCode"
          loading={summary.isLoading}
          pagination={false}
          dataSource={s?.today.currencies ?? []}
          columns={[
            { title: '재화', dataIndex: 'currencyCode' },
            { title: '발행', dataIndex: 'issued', align: 'right', render: fmtNumber },
            { title: '소모', dataIndex: 'consumed', align: 'right', render: fmtNumber },
            {
              title: '순증감',
              key: 'net',
              align: 'right',
              render: (_, r) => fmtNumber(r.issued - r.consumed),
            },
          ]}
        />
      </Card>
    </>
  );
}
