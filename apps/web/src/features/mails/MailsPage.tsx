import { Button, Card, DatePicker, Form, Progress, Select, Table, Tag, Typography } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { Permission, type MailStatus, type MailSummary, type MailType } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { MAIL_TYPE_LABEL, MailStatusTag, RewardTags } from './common';

interface SearchValues {
  type?: MailType;
  status?: MailStatus;
  range?: [Dayjs, Dayjs];
}

/** 우편 발송 내역. 검색 조건·페이지는 URL 에 저장 */
export function MailsPage() {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm<SearchValues>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = Object.fromEntries(params.entries());
  const page = Number(params.get('page') ?? 1);
  const size = Number(params.get('size') ?? 20);

  const { data, isFetching } = useQuery({
    queryKey: ['mails', query],
    queryFn: () => api.get<MailSummary[]>('/mails', query),
    placeholderData: keepPreviousData,
  });

  function onSearch(v: SearchValues) {
    const next: Record<string, string> = {};
    if (v.type) next.type = v.type;
    if (v.status) next.status = v.status;
    if (v.range) {
      next.from = v.range[0].startOf('day').toISOString();
      next.to = v.range[1].endOf('day').toISOString();
    }
    setParams(next);
  }

  return (
    <>
      <PageHeader
        title="우편 관리"
        extra={
          can(Permission.MAIL_SEND) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/mails/new')}>
              우편 발송
            </Button>
          )
        }
      />
      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          style={{ rowGap: 8 }}
          initialValues={{
            type: params.get('type') ?? undefined,
            status: params.get('status') ?? undefined,
            range:
              params.get('from') && params.get('to')
                ? [dayjs(params.get('from')), dayjs(params.get('to'))]
                : undefined,
          }}
        >
          <Form.Item name="type">
            <Select
              placeholder="유형"
              allowClear
              style={{ width: 110 }}
              options={[
                { value: 'USER', label: '개별' },
                { value: 'GLOBAL', label: '전체' },
              ]}
            />
          </Form.Item>
          <Form.Item name="status">
            <Select
              placeholder="상태"
              allowClear
              style={{ width: 110 }}
              options={[
                { value: 'SENT', label: '발송' },
                { value: 'CANCELED', label: '취소' },
              ]}
            />
          </Form.Item>
          <Form.Item name="range">
            <DatePicker.RangePicker placeholder={['발송 시작일', '종료일']} />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
            검색
          </Button>
          <Button
            style={{ marginLeft: 8 }}
            onClick={() => {
              form.setFieldsValue({ type: undefined, status: undefined, range: undefined });
              setParams({});
            }}
          >
            초기화
          </Button>
        </Form>
      </Card>

      <Card>
        <Table<MailSummary>
          rowKey="id"
          size="small"
          loading={isFetching}
          dataSource={data?.data ?? []}
          scroll={{ x: 1100 }}
          onRow={(r) => ({
            onClick: () => navigate(`/mails/${r.id}`),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: page,
            pageSize: size,
            total: Number(data?.meta?.total ?? 0),
            showSizeChanger: true,
            showTotal: (n) => `총 ${fmtNumber(n)}건`,
            onChange: (p, s) => setParams({ ...query, page: String(p), size: String(s) }),
          }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 70 },
            {
              title: '유형',
              dataIndex: 'type',
              width: 70,
              render: (t: MailType) => (
                <Tag color={t === 'GLOBAL' ? 'magenta' : 'default'}>{MAIL_TYPE_LABEL[t]}</Tag>
              ),
            },
            {
              title: '제목',
              dataIndex: 'title',
              ellipsis: true,
              render: (v: string, r) => (
                <Link to={`/mails/${r.id}`} onClick={(e) => e.stopPropagation()}>
                  {v}
                </Link>
              ),
            },
            {
              title: '보상',
              dataIndex: 'rewards',
              width: 240,
              render: (_, r) => <RewardTags rewards={r.rewards} />,
            },
            {
              title: '수령',
              width: 170,
              render: (_, r) =>
                r.recipientCount === null ? (
                  <Typography.Text>{fmtNumber(r.claimedCount)}명 수령</Typography.Text>
                ) : (
                  <Progress
                    size="small"
                    percent={
                      r.recipientCount ? Math.round((r.claimedCount / r.recipientCount) * 100) : 0
                    }
                    format={() => `${fmtNumber(r.claimedCount)}/${fmtNumber(r.recipientCount!)}`}
                  />
                ),
            },
            {
              title: '상태',
              width: 70,
              render: (_, r) => <MailStatusTag status={r.status} expiresAt={r.expiresAt} />,
            },
            { title: '만료', dataIndex: 'expiresAt', width: 140, render: fmtDateTime },
            { title: '발송자', width: 100, render: (_, r) => r.createdBy.name },
            { title: '발송일', dataIndex: 'sentAt', width: 140, render: fmtDateTime },
          ]}
        />
      </Card>
    </>
  );
}
