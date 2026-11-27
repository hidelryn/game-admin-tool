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
import { Typography } from 'antd';
import type { AssistantChart as Chart } from '@game-admin/shared';
import { AXIS_TEXT, GRID, SERIES } from '../../shared/charts/palette';
import { fmtNumber } from '../../shared/format';

/** AI 가 정한 차트 정의(JSON)를 그린다 — 데이터·축만 받고, 모양은 앱의 차트 규칙을 따른다 */
export function AssistantChart({ chart }: { chart: Chart }) {
  const fmt = (v: unknown) =>
    typeof v === 'number'
      ? `${fmtNumber(Math.round(v * 100) / 100)}${chart.unit ?? ''}`
      : String(v);
  const axis = { tick: { fill: AXIS_TEXT, fontSize: 11 }, tickLine: false, axisLine: false };
  const common = {
    data: chart.data,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
  };
  const children = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey={chart.xKey} {...axis} minTickGap={16} />
      <YAxis width={56} {...axis} tickFormatter={(v: number) => fmtNumber(v)} />
      <Tooltip formatter={(v: unknown) => fmt(v)} />
      {chart.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );

  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {chart.title}
      </Typography.Text>
      <div style={{ width: '100%', height: 200, marginTop: 4 }}>
        <ResponsiveContainer>
          {chart.type === 'line' ? (
            <LineChart {...common}>
              {children}
              {chart.series.map((s, i) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stroke={SERIES[i % SERIES.length]}
                  strokeWidth={2}
                  dot={chart.data.length <= 14}
                  connectNulls
                />
              ))}
            </LineChart>
          ) : (
            <BarChart {...common} barCategoryGap="20%">
              {children}
              {chart.series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={SERIES[i % SERIES.length]}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
