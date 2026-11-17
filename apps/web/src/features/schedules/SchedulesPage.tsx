import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Row,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { Permission, type ScheduleKind, type ScheduleView } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import {
  FREQUENCY_LABEL,
  KIND_COLOR,
  KIND_LABEL,
  KindTag,
  StatusTag,
  fmtPeriod,
  scheduleLabel,
} from './common';
import { ScheduleEditor } from './ScheduleEditor';

type KindFilter = 'ALL' | ScheduleKind;

/**
 * 스케줄 — 랭킹 시즌·게임 이벤트의 기간과 게임 노출(팝업·배너)
 * 월간 타임라인 + 목록. 월·필터는 URL 에 저장
 */
export function SchedulesPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const month = dayjs(params.get('month') ?? undefined).isValid()
    ? dayjs(params.get('month') ?? undefined).startOf('month')
    : dayjs().startOf('month');
  const kind = (params.get('kind') as KindFilter | null) ?? 'ALL';
  const includeCanceled = params.get('canceled') === 'true';
  const [editing, setEditing] = useState<{ schedule?: ScheduleView; start?: Dayjs } | null>(null);

  const from = month.startOf('month');
  const to = month.endOf('month');
  const set = (patch: Record<string, string | undefined>) => {
    const next = Object.fromEntries(params.entries());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    setParams(next);
  };

  const list = useQuery({
    queryKey: ['schedules', from.toISOString(), kind, includeCanceled],
    queryFn: async () =>
      (
        await api.get<ScheduleView[]>('/schedules', {
          from: from.toISOString(),
          to: to.toISOString(),
          ...(kind === 'ALL' ? {} : { kind }),
          ...(includeCanceled ? { includeCanceled: 'true' } : {}),
        })
      ).data,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000, // 상태(예정→진행→종료)는 시각으로 바뀌므로 주기적으로 다시
  });

  // 운영 로그에서 "스케줄 #id" 로 들어오면 그 일정을 연다
  const focus = Number(params.get('focus'));
  useEffect(() => {
    if (!focus) return;
    void api.get<ScheduleView>(`/schedules/${focus}`).then(({ data }) => {
      setEditing({ schedule: data });
      set({ focus: undefined, month: dayjs(data.startsAt).format('YYYY-MM') });
    });
  }, [focus]); // focus 가 바뀔 때만 (set 은 매 렌더 새로 만들어짐)

  const rows = list.data ?? [];

  return (
    <>
      <PageHeader
        title="스케줄"
        sub="랭킹 시즌과 게임 이벤트의 기간, 게임 안 팝업·배너 노출을 관리합니다"
        extra={
          can(Permission.SCHEDULE_MANAGE) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({})}>
              일정 추가
            </Button>
          )
        }
      />
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card>
            <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
              <Space>
                <Button
                  icon={<LeftOutlined />}
                  onClick={() => set({ month: month.subtract(1, 'month').format('YYYY-MM') })}
                  aria-label="이전 달"
                />
                <Typography.Title
                  level={4}
                  style={{ margin: 0, minWidth: 130, textAlign: 'center' }}
                >
                  {month.format('YYYY년 M월')}
                </Typography.Title>
                <Button
                  icon={<RightOutlined />}
                  onClick={() => set({ month: month.add(1, 'month').format('YYYY-MM') })}
                  aria-label="다음 달"
                />
                <Button onClick={() => set({ month: undefined })}>이번 달</Button>
              </Space>
              <Space wrap>
                <Segmented<KindFilter>
                  value={kind}
                  onChange={(v) => set({ kind: v === 'ALL' ? undefined : v })}
                  options={[
                    { value: 'ALL', label: '전체' },
                    { value: 'RANKING_SEASON', label: '랭킹 시즌' },
                    { value: 'EVENT', label: '이벤트' },
                  ]}
                />
                <Space size={4}>
                  <Switch
                    size="small"
                    checked={includeCanceled}
                    onChange={(v) => set({ canceled: v ? 'true' : undefined })}
                  />
                  <Typography.Text type="secondary">취소 포함</Typography.Text>
                </Space>
              </Space>
            </Flex>
            <MonthTimeline
              month={month}
              rows={rows}
              loading={list.isLoading}
              onOpen={(s) => setEditing({ schedule: s })}
              onCreateAt={
                can(Permission.SCHEDULE_MANAGE) ? (d) => setEditing({ start: d }) : undefined
              }
            />
          </Card>

          <Card title="목록" style={{ marginTop: 16 }}>
            <Table<ScheduleView>
              rowKey="id"
              size="small"
              loading={list.isLoading}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 900 }}
              onRow={(r) => ({
                onClick: () => setEditing({ schedule: r }),
                style: { cursor: 'pointer' },
              })}
              locale={{ emptyText: <Empty description="이 달에 일정이 없습니다" /> }}
              columns={[
                {
                  title: '종류',
                  dataIndex: 'kind',
                  width: 110,
                  render: (k: ScheduleKind) => <KindTag kind={k} />,
                },
                { title: '제목', ellipsis: true, render: (_, r) => scheduleLabel(r) },
                { title: '기간', width: 280, render: (_, r) => fmtPeriod(r) },
                {
                  title: '상태',
                  dataIndex: 'status',
                  width: 80,
                  render: (s: ScheduleView['status']) => <StatusTag status={s} />,
                },
                {
                  title: '노출',
                  width: 200,
                  render: (_, r) => (
                    <>
                      {r.popupEnabled && <Tag>팝업 · {FREQUENCY_LABEL[r.popupFrequency]}</Tag>}
                      {r.bannerEnabled && <Tag>배너 · {r.priority}</Tag>}
                      {!r.popupEnabled && !r.bannerEnabled && (
                        <Typography.Text type="secondary">-</Typography.Text>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <ScheduleEditor
        open={editing !== null}
        schedule={editing?.schedule}
        defaultStart={editing?.start}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

/** 월간 간트: 날짜 칸 + 일정마다 한 줄 막대 (달 밖으로 이어지면 끝이 잘린 모양) */
function MonthTimeline({
  month,
  rows,
  loading,
  onOpen,
  onCreateAt,
}: {
  month: Dayjs;
  rows: ScheduleView[];
  loading: boolean;
  onOpen(s: ScheduleView): void;
  onCreateAt?(d: Dayjs): void;
}) {
  const days = month.daysInMonth();
  const start = month.startOf('month');
  const end = month.endOf('month');
  const span = end.valueOf() - start.valueOf();
  const pct = (d: Dayjs) =>
    Math.min(100, Math.max(0, ((d.valueOf() - start.valueOf()) / span) * 100));
  const now = dayjs();
  const todayPct = now.isAfter(start) && now.isBefore(end) ? pct(now) : null;
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        a.kind === b.kind
          ? dayjs(a.startsAt).valueOf() - dayjs(b.startsAt).valueOf()
          : a.kind === 'RANKING_SEASON'
            ? -1
            : 1,
      ),
    [rows],
  );

  const grid = (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${days}, 1fr)`,
        pointerEvents: 'none',
      }}
    >
      {Array.from({ length: days }, (_, i) => {
        const d = start.add(i, 'day');
        const weekend = d.day() === 0 || d.day() === 6;
        return (
          <div
            key={i}
            style={{ borderLeft: '1px solid #f0f0f0', background: weekend ? '#fafafa' : undefined }}
          />
        );
      })}
    </div>
  );

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 720 }}>
        {/* 날짜 머리 — 누르면 그날 시작하는 일정 추가 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${days}, 1fr)`,
            fontSize: 11,
            color: '#8c8c8c',
            marginBottom: 4,
          }}
        >
          {Array.from({ length: days }, (_, i) => {
            const d = start.add(i, 'day');
            const isToday = d.isSame(now, 'day');
            return (
              <div
                key={i}
                onClick={onCreateAt ? () => onCreateAt(d) : undefined}
                title={onCreateAt ? `${d.format('M/D')} 시작 일정 추가` : undefined}
                style={{
                  textAlign: 'center',
                  cursor: onCreateAt ? 'pointer' : undefined,
                  fontWeight: isToday ? 700 : undefined,
                  color: isToday ? '#2a78d6' : d.day() === 0 ? '#cf1322' : undefined,
                }}
              >
                {d.date()}
              </div>
            );
          })}
        </div>

        <div
          style={{
            position: 'relative',
            minHeight: 120,
            borderTop: '1px solid #f0f0f0',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          {grid}
          {todayPct !== null && (
            <Tooltip title={`지금 ${now.format('M/D HH:mm')}`}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${todayPct}%`,
                  width: 2,
                  background: '#cf1322',
                  zIndex: 2,
                }}
              />
            </Tooltip>
          )}
          {!loading && !sorted.length && (
            <div
              style={{ position: 'relative', padding: 40, textAlign: 'center', color: '#8c8c8c' }}
            >
              이 달에 일정이 없습니다{onCreateAt ? ' — 날짜를 눌러 추가할 수 있어요' : ''}
            </div>
          )}
          <div style={{ position: 'relative', padding: '8px 0' }}>
            {sorted.map((s) => {
              const sStart = dayjs(s.startsAt);
              const sEnd = dayjs(s.endsAt);
              const left = pct(sStart);
              const width = Math.max(1.2, pct(sEnd) - left);
              const cutLeft = sStart.isBefore(start);
              const cutRight = sEnd.isAfter(end);
              const canceled = s.status === 'CANCELED';
              const color = KIND_COLOR[s.kind];
              return (
                <div key={s.id} style={{ position: 'relative', height: 30, marginBottom: 4 }}>
                  <Tooltip title={`${KIND_LABEL[s.kind]} · ${scheduleLabel(s)} · ${fmtPeriod(s)}`}>
                    <div
                      onClick={() => onOpen(s)}
                      style={{
                        position: 'absolute',
                        left: `${left}%`,
                        width: `${width}%`,
                        top: 2,
                        bottom: 2,
                        cursor: 'pointer',
                        borderRadius: `${cutLeft ? 0 : 6}px ${cutRight ? 0 : 6}px ${cutRight ? 0 : 6}px ${cutLeft ? 0 : 6}px`,
                        background: canceled
                          ? `repeating-linear-gradient(45deg, #d9d9d9, #d9d9d9 6px, #f0f0f0 6px, #f0f0f0 12px)`
                          : color,
                        opacity: s.status === 'ENDED' ? 0.45 : 1,
                        color: canceled ? '#595959' : '#fff',
                        fontSize: 12,
                        padding: '0 8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textDecoration: canceled ? 'line-through' : undefined,
                        boxShadow: s.status === 'ACTIVE' ? `0 0 0 2px ${color}40` : undefined,
                      }}
                    >
                      {scheduleLabel(s)}
                      {s.popupEnabled && <span style={{ opacity: 0.85 }}>· 팝업</span>}
                      {s.bannerEnabled && <span style={{ opacity: 0.85 }}>· 배너</span>}
                    </div>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
        <Space size={16} style={{ marginTop: 8, fontSize: 12, color: '#8c8c8c' }} wrap>
          {(Object.keys(KIND_COLOR) as ScheduleKind[]).map((k) => (
            <span key={k}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: KIND_COLOR[k],
                  marginRight: 4,
                }}
              />
              {KIND_LABEL[k]}
            </span>
          ))}
          <span>흐린 막대 = 종료 · 빗금 = 취소 · 빨간 선 = 지금</span>
        </Space>
      </div>
    </div>
  );
}
