import { useState, type ReactNode } from 'react';
import {
  Alert,
  Card,
  Col,
  Empty,
  Flex,
  Row,
  Segmented,
  Select,
  Skeleton,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tooltip as AntTooltip,
  Typography,
} from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  ChurnReport,
  CurrencyInfo,
  PurchaseReport,
  RetentionReport,
  SpendingReport,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { PageHeader } from '../../shared/components/PageHeader';
import { fmtNumber } from '../../shared/format';
import { AXIS_TEXT, GRID, SERIES } from '../../shared/charts/palette';

/**
 * 유저 분석 (docs/analytics.md) — 이탈 구간 · 리텐션 · 과금 · 재화 소비처
 * 구간 = "다음 도전 스테이지" 10 단위 (최고 클리어 19 → 11~20 구간)
 */
const pct = (r: number | null | undefined) =>
  r === null || r === undefined ? '-' : `${(r * 100).toFixed(1)}%`;
const won = (n: number) => `${fmtNumber(n)}원`;
const stageLabel = (b: { stageFrom: number; stageTo: number }) => `${b.stageFrom}~${b.stageTo}`;

const PERIODS = [
  { value: 7, label: '7일' },
  { value: 30, label: '30일' },
  { value: 90, label: '90일' },
];
const periodQuery = (days: number) => ({
  from: dayjs()
    .subtract(days - 1, 'day')
    .format('YYYY-MM-DD'),
  to: dayjs().format('YYYY-MM-DD'),
});

/** 단일 계열 막대 (한 축, 4px 둥근 끝, 마우스 올리면 값) */
function Bars<T extends object>({
  data,
  x,
  y,
  name,
  format = fmtNumber,
  color = SERIES[0],
  height = 260,
  highlight,
  tick,
  horizontal = false,
}: {
  data: T[];
  x: (d: T) => string;
  y: keyof T & string;
  name: string;
  format?: (v: number) => string;
  color?: string;
  height?: number;
  /** 값 라벨을 붙일 막대 (상위 몇 개만 — 모든 막대에 숫자를 붙이지 않음) */
  highlight?: (d: T) => boolean;
  /** 축 눈금 글자 (짧게). 툴팁에는 원래 이름이 나온다 */
  tick?: (label: string) => string;
  /** 가로 막대 — 이름이 긴 범주(사유 등)용 */
  horizontal?: boolean;
}) {
  const rows = data.map((d) => ({
    ...d,
    __x: x(d),
    __label: highlight?.(d) ? format(Number(d[y])) : '',
  }));
  const axisText = { fill: AXIS_TEXT, fontSize: 12 };
  const valueAxis = {
    tick: axisText,
    tickLine: false,
    axisLine: false,
    tickFormatter: (v: unknown) => format(Number(v)),
  };
  const nameAxis = {
    dataKey: '__x',
    tick: axisText,
    tickLine: false,
    axisLine: { stroke: GRID },
    interval: 0,
    tickFormatter: tick ? (v: unknown) => tick(String(v)) : undefined,
  } as const;
  return (
    <ResponsiveContainer
      width="100%"
      height={horizontal ? Math.max(120, rows.length * 36 + 24) : height}
    >
      <BarChart
        data={rows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: horizontal ? 0 : 20, right: horizontal ? 72 : 8, bottom: 0, left: 0 }}
        barCategoryGap="20%"
      >
        <CartesianGrid stroke={GRID} vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" {...valueAxis} />
            <YAxis type="category" width={120} {...nameAxis} />
          </>
        ) : (
          <>
            <XAxis {...nameAxis} />
            <YAxis width={64} {...valueAxis} />
          </>
        )}
        <Tooltip
          formatter={(v: unknown) => [format(Number(v)), name]}
          labelFormatter={(d: unknown) => String(d)}
          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
        />
        <Bar
          dataKey={y as string}
          name={name}
          fill={color}
          radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          maxBarSize={horizontal ? 20 : 36}
        >
          <LabelList
            dataKey="__label"
            position={horizontal ? 'right' : 'top'}
            style={{ fill: AXIS_TEXT, fontSize: 11 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** 구간 눈금은 끝 스테이지만 ("~20") — 12개 구간이 좁은 카드에서도 겹치지 않게 */
const stageTick = (label: string) => `~${label.split('~')[1] ?? label}`;

/** 상위 n개 값 표시용 */
const topN = <T,>(rows: T[], key: (r: T) => number, n = 3) => {
  const cut = [...rows].map(key).sort((a, b) => b - a)[n - 1] ?? Infinity;
  return (r: T) => key(r) > 0 && key(r) >= cut;
};

function Hint({ children }: { children: ReactNode }) {
  return (
    <AntTooltip title={children}>
      <QuestionCircleOutlined style={{ color: AXIS_TEXT, marginLeft: 6 }} />
    </AntTooltip>
  );
}

// ───────────── 이탈 ─────────────

function ChurnTab({ asTable }: { asTable: boolean }) {
  const [days, setDays] = useState(7);
  const q = useQuery({
    queryKey: ['analytics', 'churn', days],
    queryFn: async () =>
      (await api.get<ChurnReport>('/analytics/churn', { inactiveDays: days })).data,
  });
  const d = q.data;
  return (
    <>
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          이탈 = 아래 기간 이상 접속하지 않은 회원 (탈퇴 제외, 가입 후 그만큼 지난 회원만 판정)
        </Typography.Text>
        <Segmented
          value={days}
          onChange={(v) => setDays(Number(v))}
          options={[3, 7, 14, 30].map((v) => ({ value: v, label: `${v}일 미접속` }))}
        />
      </Flex>
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic
              title="판정 대상"
              value={d?.evaluated ?? 0}
              formatter={(v) => fmtNumber(Number(v))}
              loading={q.isLoading}
            />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic
              title="이탈 회원"
              value={d?.churned ?? 0}
              formatter={(v) => fmtNumber(Number(v))}
              loading={q.isLoading}
            />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic
              title="전체 이탈률"
              value={pct(d ? d.churned / Math.max(1, d.evaluated) : 0)}
              loading={q.isLoading}
            />
          </Card>
        </Col>
      </Row>
      <Card
        style={{ marginTop: 16 }}
        title={
          <>
            스테이지 구간별 이탈률
            <Hint>
              그 구간까지 온 회원 중, 그 구간에서 더 못 나아간 채 이탈한 비율. 구간은 &quot;다음에
              도전할 스테이지&quot; 기준 (최고 클리어 19 → 11~20)
            </Hint>
          </>
        }
      >
        {q.isLoading ? (
          <Skeleton active />
        ) : !d ? (
          <Empty />
        ) : asTable ? null : (
          <Bars
            data={d.buckets}
            x={stageLabel}
            tick={stageTick}
            y="churnRate"
            name="이탈률"
            format={pct}
            highlight={topN(d.buckets, (b) => b.churnRate)}
          />
        )}
        {d && (
          <Table
            style={{ marginTop: asTable ? 0 : 16 }}
            size="small"
            rowKey="stageFrom"
            pagination={false}
            dataSource={d.buckets}
            columns={[
              { title: '구간(스테이지)', render: (_, b) => stageLabel(b) },
              { title: '도달', dataIndex: 'reached', align: 'right', render: fmtNumber },
              {
                title: '이 구간에서 멈춤',
                dataIndex: 'stopped',
                align: 'right',
                render: fmtNumber,
              },
              { title: '이탈', dataIndex: 'churned', align: 'right', render: fmtNumber },
              { title: '이탈률', dataIndex: 'churnRate', align: 'right', render: pct },
            ]}
          />
        )}
      </Card>
    </>
  );
}

// ───────────── 리텐션 ─────────────

/** 단일 색 명도 단계 (sequential) — 높을수록 진하게, 글자는 배경에 맞춰 */
function RateCell({ rate }: { rate: number | null }) {
  if (rate === null) return <Typography.Text type="secondary">-</Typography.Text>;
  const a = Math.min(1, rate / 0.6);
  return (
    <div
      style={{
        background: `rgba(42, 120, 214, ${0.08 + a * 0.82})`,
        color: a > 0.55 ? '#fff' : '#1d2340',
        borderRadius: 4,
        padding: '2px 6px',
        textAlign: 'right',
      }}
    >
      {pct(rate)}
    </div>
  );
}

function RetentionTab() {
  const [period, setPeriod] = useState(30);
  const q = useQuery({
    queryKey: ['analytics', 'retention', period],
    queryFn: async () =>
      (await api.get<RetentionReport>('/analytics/retention', periodQuery(period))).data,
  });
  const d = q.data;
  const avg = (day: number) => {
    const vals = (d?.cohorts ?? []).filter((c) => c.size > 0 && c.rates[day] !== null);
    const size = vals.reduce((s, c) => s + c.size, 0);
    return size ? vals.reduce((s, c) => s + c.rates[day]! * c.size, 0) / size : null;
  };
  return (
    <>
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          가입일(KST)별로, 가입 후 n일째 되는 날 다시 접속한 회원 비율. 아직 그날이 안 왔으면
          &quot;-&quot;
        </Typography.Text>
        <Segmented value={period} onChange={(v) => setPeriod(Number(v))} options={PERIODS} />
      </Flex>
      <Card title="가입 코호트 리텐션">
        <Table
          size="small"
          rowKey="date"
          loading={q.isLoading}
          pagination={{ pageSize: 15, hideOnSinglePage: true }}
          scroll={{ x: 640 }}
          dataSource={[...(d?.cohorts ?? [])].reverse()}
          summary={() =>
            d ? (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}>
                    <b>가중 평균</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    {fmtNumber(d.cohorts.reduce((s, c) => s + c.size, 0))}
                  </Table.Summary.Cell>
                  {d.days.map((day, i) => (
                    <Table.Summary.Cell index={i + 2} key={day}>
                      <RateCell rate={avg(day)} />
                    </Table.Summary.Cell>
                  ))}
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
          columns={[
            { title: '가입일', dataIndex: 'date', width: 120 },
            { title: '가입자', dataIndex: 'size', align: 'right', width: 90, render: fmtNumber },
            ...(d?.days ?? [1, 3, 7, 14, 30]).map((day) => ({
              title: `D${day}`,
              key: `d${day}`,
              width: 90,
              render: (_: unknown, c: RetentionReport['cohorts'][number]) =>
                c.size ? <RateCell rate={c.rates[day] ?? null} /> : '-',
            })),
          ]}
        />
      </Card>
    </>
  );
}

// ───────────── 과금 ─────────────

function PurchasesTab({ asTable }: { asTable: boolean }) {
  const [period, setPeriod] = useState(30);
  const q = useQuery({
    queryKey: ['analytics', 'purchases', period],
    queryFn: async () =>
      (await api.get<PurchaseReport>('/analytics/purchases', periodQuery(period))).data,
  });
  const d = q.data;
  const stat = (title: ReactNode, value: string) => (
    <Col xs={12} lg={6}>
      <Card>
        <Statistic title={title} value={value} loading={q.isLoading} />
      </Card>
    </Col>
  );
  return (
    <>
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">가상 결제 데이터 · 금액은 원 단위</Typography.Text>
        <Segmented value={period} onChange={(v) => setPeriod(Number(v))} options={PERIODS} />
      </Flex>
      <Row gutter={[16, 16]}>
        {stat('매출', d ? won(d.revenue) : '-')}
        {stat('결제자', d ? `${fmtNumber(d.payers)}명` : '-')}
        {stat(
          <>
            결제율
            <Hint>기간 중 접속한 회원 중 결제한 회원 비율</Hint>
          </>,
          d ? pct(d.payerRate) : '-',
        )}
        {stat(
          <>
            ARPPU
            <Hint>결제 회원 1인당 결제액</Hint>
          </>,
          d ? won(d.arppu) : '-',
        )}
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={12}>
          <Card
            title={
              <>
                첫 결제가 일어난 구간
                <Hint>기간 안에 처음 결제한 회원이, 결제 당시 도전 중이던 스테이지 구간</Hint>
              </>
            }
          >
            {q.isLoading || !d ? (
              <Skeleton active />
            ) : asTable ? (
              <Table
                size="small"
                rowKey="stageFrom"
                pagination={false}
                dataSource={d.byStage}
                columns={[
                  { title: '구간', render: (_, b) => stageLabel(b) },
                  {
                    title: '첫 결제자',
                    dataIndex: 'firstPayers',
                    align: 'right',
                    render: fmtNumber,
                  },
                  { title: '결제 건수', dataIndex: 'purchases', align: 'right', render: fmtNumber },
                  { title: '매출', dataIndex: 'revenue', align: 'right', render: won },
                ]}
              />
            ) : (
              <Bars
                data={d.byStage}
                x={stageLabel}
                tick={stageTick}
                y="firstPayers"
                name="첫 결제자"
                highlight={topN(d.byStage, (b) => b.firstPayers)}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="구간별 매출">
            {q.isLoading || !d ? (
              <Skeleton active />
            ) : asTable ? null : (
              <Bars
                data={d.byStage}
                x={stageLabel}
                tick={stageTick}
                y="revenue"
                name="매출"
                format={won}
                color={SERIES[1]}
                highlight={topN(d.byStage, (b) => b.revenue)}
              />
            )}
            {asTable && d && (
              <Typography.Text type="secondary">
                왼쪽 표에 구간별 매출이 같이 있습니다.
              </Typography.Text>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="첫 결제까지 걸린 기간 (가입 후)">
            {q.isLoading || !d ? (
              <Skeleton active />
            ) : asTable ? (
              <Table
                size="small"
                rowKey="label"
                pagination={false}
                dataSource={d.firstPurchaseDay}
                columns={[
                  { title: '가입 후', dataIndex: 'label' },
                  { title: '첫 결제자', dataIndex: 'payers', align: 'right', render: fmtNumber },
                ]}
              />
            ) : (
              <Bars
                data={d.firstPurchaseDay}
                x={(r) => r.label}
                y="payers"
                name="첫 결제자"
                height={220}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="상품별 매출">
            <Table
              size="small"
              rowKey="code"
              loading={q.isLoading}
              pagination={false}
              dataSource={d?.byProduct ?? []}
              columns={[
                { title: '상품', dataIndex: 'name' },
                { title: '건수', dataIndex: 'purchases', align: 'right', render: fmtNumber },
                { title: '매출', dataIndex: 'revenue', align: 'right', render: won },
                {
                  title: '비중',
                  key: 'share',
                  align: 'right',
                  render: (_, r) => pct(d && d.revenue ? r.revenue / d.revenue : 0),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}

// ───────────── 재화 소비처 ─────────────

function SpendingTab({ asTable }: { asTable: boolean }) {
  const [period, setPeriod] = useState(30);
  const [currency, setCurrency] = useState('GOLD');
  const currencies = useQuery({
    queryKey: ['currencies'],
    queryFn: async () => (await api.get<CurrencyInfo[]>('/currencies')).data,
    retry: false,
  });
  const q = useQuery({
    queryKey: ['analytics', 'spending', currency, period],
    queryFn: async () =>
      (
        await api.get<SpendingReport>('/analytics/spending', {
          ...periodQuery(period),
          currencyCode: currency,
        })
      ).data,
  });
  const d = q.data;
  return (
    <>
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          게임 안 소비만 집계 (운영자 회수 제외) · 기간 소비 {d ? fmtNumber(d.total) : '-'}
        </Typography.Text>
        <Flex gap={8}>
          <Select
            value={currency}
            onChange={setCurrency}
            style={{ width: 120 }}
            options={(currencies.data ?? [{ code: 'GOLD', name: '골드' }]).map((c) => ({
              value: c.code,
              label: c.name,
            }))}
          />
          <Segmented value={period} onChange={(v) => setPeriod(Number(v))} options={PERIODS} />
        </Flex>
      </Flex>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="어디에 썼나 (사유별)">
            {q.isLoading ? (
              <Skeleton active />
            ) : !d?.byReason.length ? (
              <Empty description="기간 안 소비 기록이 없습니다" />
            ) : (
              <>
                {!asTable && (
                  <Bars
                    data={d.byReason.slice(0, 8)}
                    x={(r) => r.reason}
                    y="amount"
                    name="소비량"
                    horizontal
                    highlight={() => true}
                  />
                )}
                <Table
                  style={{ marginTop: asTable ? 0 : 16 }}
                  size="small"
                  rowKey="reason"
                  pagination={false}
                  dataSource={d.byReason}
                  columns={[
                    { title: '사유', dataIndex: 'reason' },
                    { title: '횟수', dataIndex: 'count', align: 'right', render: fmtNumber },
                    { title: '소비량', dataIndex: 'amount', align: 'right', render: fmtNumber },
                    { title: '비중', dataIndex: 'share', align: 'right', render: pct },
                  ]}
                />
              </>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title={
              <>
                진행 구간별 소비
                <Hint>소비한 회원의 &quot;현재&quot; 진행 구간 기준 (소비 당시 구간이 아님)</Hint>
              </>
            }
          >
            {q.isLoading || !d ? (
              <Skeleton active />
            ) : asTable ? (
              <Table
                size="small"
                rowKey="stageFrom"
                pagination={false}
                dataSource={d.byStage}
                columns={[
                  { title: '구간', render: (_, b) => stageLabel(b) },
                  { title: '소비 회원', dataIndex: 'users', align: 'right', render: fmtNumber },
                  { title: '소비량', dataIndex: 'amount', align: 'right', render: fmtNumber },
                ]}
              />
            ) : (
              <Bars
                data={d.byStage}
                x={stageLabel}
                tick={stageTick}
                y="amount"
                name="소비량"
                color={SERIES[2]}
                highlight={topN(d.byStage, (b) => b.amount)}
              />
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}

// ───────────── 페이지 ─────────────

const TABS = ['churn', 'retention', 'purchases', 'spending'] as const;
type Tab = (typeof TABS)[number];

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'churn';
  const [asTable, setAsTable] = useState(false);
  return (
    <>
      <PageHeader
        title="유저 분석"
        sub="어디서 떠나는지 · 언제 결제하는지 · 재화를 어디에 쓰는지 (결과는 10분마다 새로 계산)"
        extra={
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary">표로 보기</Typography.Text>
            <Switch size="small" checked={asTable} onChange={setAsTable} />
          </Flex>
        }
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="가상 데이터입니다"
        description="회원은 스테이지를 순서대로 진행하고 20·45·80 스테이지가 난이도 벽입니다. 벽에서 이탈과 결제가 몰리도록 만든 시뮬레이션 데이터라, 실제 게임 지표가 아닙니다."
      />
      <Tabs
        activeKey={tab}
        onChange={(k) => setParams({ tab: k }, { replace: true })}
        items={[
          { key: 'churn', label: '이탈 구간', children: <ChurnTab asTable={asTable} /> },
          { key: 'retention', label: '리텐션', children: <RetentionTab /> },
          { key: 'purchases', label: '과금', children: <PurchasesTab asTable={asTable} /> },
          { key: 'spending', label: '재화 소비처', children: <SpendingTab asTable={asTable} /> },
        ]}
      />
    </>
  );
}
