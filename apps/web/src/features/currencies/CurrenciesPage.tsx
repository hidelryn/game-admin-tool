import { useState } from 'react';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { CloseOutlined, SearchOutlined, SwapOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { Permission, type CurrencyBalance, type CurrencyInfo } from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { fmtNumber } from '../../shared/format';
import { BulkGrantPanel } from './BulkGrantPanel';
import { CurrencyChangeModal } from './CurrencyChangeModal';
import { CurrencyLedgerTable, type LedgerFilter } from './CurrencyLedgerTable';
import { SOURCE_LABEL, useCurrencies } from './common';

interface SearchValues {
  publicId?: string;
  currencyCode?: string;
  source?: string;
  range?: [Dayjs, Dayjs];
}

/** 재화 관리: 거래 원장 · 대량 지급 · 재화 정보(조회 전용). 탭과 검색 조건은 URL 에 저장 */
export function CurrenciesPage() {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm<SearchValues>();
  /** 지급·회수 모달: undefined=닫힘, ''=회원 직접 입력, 그 외=해당 회원 고정 */
  const [changeTarget, setChangeTarget] = useState<string | undefined>();
  const { can } = useAuth();
  const currencies = useCurrencies();

  const tab = params.get('tab') ?? 'ledger';
  const filter: LedgerFilter = {
    publicId: params.get('publicId') ?? undefined,
    currencyCode: params.get('currencyCode') ?? undefined,
    source: params.get('source') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  };
  const canChange = can(Permission.CURRENCY_GRANT) || can(Permission.CURRENCY_DEDUCT);

  /** 원장에서 회원을 누르면 그 회원 기준으로 거르고 요약 카드를 띄운다 (페이지 이동 없음) */
  function focusUser(publicId: string) {
    form.setFieldsValue({ publicId });
    setParams({ ...Object.fromEntries(params.entries()), publicId });
  }

  function clearUser() {
    form.setFieldsValue({ publicId: undefined });
    const next = Object.fromEntries(params.entries());
    delete next.publicId;
    setParams(next);
  }

  function setTab(next: string) {
    setParams(next === 'ledger' ? {} : { tab: next });
  }

  function onSearch(v: SearchValues) {
    const next: Record<string, string> = {};
    if (v.publicId?.trim()) next.publicId = v.publicId.trim();
    if (v.currencyCode) next.currencyCode = v.currencyCode;
    if (v.source) next.source = v.source;
    if (v.range) {
      next.from = v.range[0].startOf('day').toISOString();
      next.to = v.range[1].endOf('day').toISOString();
    }
    setParams(next);
  }

  return (
    <>
      <PageHeader
        title="재화 관리"
        extra={
          canChange && (
            <Button type="primary" icon={<SwapOutlined />} onClick={() => setChangeTarget('')}>
              지급·회수
            </Button>
          )
        }
      />
      <Card>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'ledger',
              label: '거래 원장',
              children: (
                <>
                  <Form
                    form={form}
                    layout="inline"
                    onFinish={onSearch}
                    style={{ marginBottom: 16, rowGap: 8 }}
                    initialValues={{
                      publicId: filter.publicId,
                      currencyCode: filter.currencyCode,
                      source: filter.source,
                      range:
                        filter.from && filter.to
                          ? [dayjs(filter.from), dayjs(filter.to)]
                          : undefined,
                    }}
                  >
                    <Form.Item name="publicId">
                      <Input placeholder="회원 ID" allowClear style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item name="currencyCode">
                      <Select
                        placeholder="재화"
                        allowClear
                        style={{ width: 150 }}
                        options={currencies.data?.map((c) => ({ value: c.code, label: c.name }))}
                      />
                    </Form.Item>
                    <Form.Item name="source">
                      <Select
                        placeholder="출처"
                        allowClear
                        style={{ width: 110 }}
                        options={Object.entries(SOURCE_LABEL).map(([value, label]) => ({
                          value,
                          label,
                        }))}
                      />
                    </Form.Item>
                    <Form.Item name="range">
                      <DatePicker.RangePicker allowClear />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                      검색
                    </Button>
                    <Button
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        form.resetFields();
                        form.setFieldsValue({
                          publicId: undefined,
                          currencyCode: undefined,
                          source: undefined,
                          range: undefined,
                        });
                        setParams({});
                      }}
                    >
                      초기화
                    </Button>
                  </Form>
                  {filter.publicId && (
                    <UserCurrencySummary
                      publicId={filter.publicId}
                      canChange={canChange}
                      onChange={() => setChangeTarget(filter.publicId)}
                      onClear={clearUser}
                    />
                  )}
                  <CurrencyLedgerTable filter={filter} onUserClick={focusUser} />
                </>
              ),
            },
            ...(can(Permission.CURRENCY_GRANT)
              ? [{ key: 'bulk', label: '대량 지급', children: <BulkGrantPanel /> }]
              : []),
            {
              key: 'info',
              label: '재화 정보',
              children: (
                <Table<CurrencyInfo>
                  rowKey="code"
                  size="small"
                  loading={currencies.isLoading}
                  pagination={false}
                  dataSource={currencies.data ?? []}
                  columns={[
                    { title: '코드', dataIndex: 'code', width: 120 },
                    { title: '이름', dataIndex: 'name' },
                    {
                      title: '구분',
                      dataIndex: 'isPaid',
                      width: 90,
                      render: (p: boolean) => (p ? <Tag color="gold">유료</Tag> : <Tag>무료</Tag>),
                    },
                    {
                      title: '최대 보유',
                      dataIndex: 'maxBalance',
                      align: 'right',
                      render: fmtNumber,
                    },
                    {
                      title: '1회 지급 상한',
                      dataIndex: 'grantLimitPerRequest',
                      align: 'right',
                      render: fmtNumber,
                    },
                  ]}
                  footer={() => (
                    <Typography.Text type="secondary">
                      조회 전용입니다. 1회 지급 상한을 넘거나 회수할 때는 실행 전 확인 단계를
                      거치며, MCP 채널에서는 유료 재화 지급도 확인 대상입니다.
                    </Typography.Text>
                  )}
                />
              ),
            },
          ]}
        />
      </Card>
      <CurrencyChangeModal
        open={changeTarget !== undefined}
        publicId={changeTarget || undefined}
        onClose={() => setChangeTarget(undefined)}
      />
    </>
  );
}

/** 원장을 회원으로 거른 상태에서 보여주는 보유 재화 요약 */
function UserCurrencySummary({
  publicId,
  canChange,
  onChange,
  onClear,
}: {
  publicId: string;
  canChange: boolean;
  onChange(): void;
  onClear(): void;
}) {
  // ['user', publicId] 아래에 두어 지급·회수 후 자동 갱신
  const balances = useQuery({
    queryKey: ['user', publicId, 'currencies'],
    queryFn: async () =>
      (await api.get<CurrencyBalance[]>(`/users/${encodeURIComponent(publicId)}/currencies`)).data,
    retry: false,
  });
  const notFound = balances.error instanceof ApiError && balances.error.status === 404;

  return (
    <Card
      size="small"
      style={{ marginBottom: 16, background: '#fafcff' }}
      title={
        <Space>
          <UserOutlined />
          <Typography.Text code>{publicId}</Typography.Text>
          <Link to={`/users/${publicId}`}>회원 상세</Link>
        </Space>
      }
      extra={
        <Space>
          {canChange && !notFound && (
            <Button size="small" type="primary" icon={<SwapOutlined />} onClick={onChange}>
              지급·회수
            </Button>
          )}
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={onClear}
            aria-label="회원 필터 해제"
          />
        </Space>
      }
    >
      {notFound ? (
        <Typography.Text type="danger">존재하지 않는 회원입니다.</Typography.Text>
      ) : (
        <Row gutter={16}>
          {(balances.data ?? []).map((b) => (
            <Col key={b.currencyCode} xs={12} sm={8} md={6}>
              <Statistic
                loading={balances.isLoading}
                title={`${b.name} (${b.currencyCode})`}
                value={b.balance}
                formatter={(v) => fmtNumber(Number(v))}
                suffix={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    / {fmtNumber(b.maxBalance)}
                  </Typography.Text>
                }
              />
            </Col>
          ))}
        </Row>
      )}
    </Card>
  );
}
