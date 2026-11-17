import { Button, Card, DatePicker, Form, Input, Select, Table } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import type { UserStatus, UserSummary } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { PageHeader } from '../../shared/components/PageHeader';
import { UserStatusTag } from '../../shared/components/StatusTag';
import { fmtDateTime, fmtNumber } from '../../shared/format';

interface SearchValues {
  publicId?: string;
  nickname?: string;
  status?: UserStatus;
  registered?: [Dayjs, Dayjs];
}

/** 검색 조건을 URL 에 저장 → 새로고침·링크 공유해도 같은 결과 */
export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm<SearchValues>();
  const page = Number(params.get('page') ?? 1);
  const size = Number(params.get('size') ?? 20);
  const query = Object.fromEntries(params.entries());

  const { data, isFetching } = useQuery({
    queryKey: ['users', query],
    queryFn: () => api.get<UserSummary[]>('/users', query),
    placeholderData: keepPreviousData,
  });

  function onSearch(v: SearchValues) {
    const next: Record<string, string> = {};
    if (v.publicId) next.publicId = v.publicId.trim();
    if (v.nickname) next.nickname = v.nickname.trim();
    if (v.status) next.status = v.status;
    if (v.registered) {
      next.registeredFrom = v.registered[0].startOf('day').toISOString();
      next.registeredTo = v.registered[1].endOf('day').toISOString();
    }
    setParams(next);
  }

  return (
    <>
      <PageHeader title="회원 관리" />
      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          initialValues={{
            publicId: params.get('publicId') ?? undefined,
            nickname: params.get('nickname') ?? undefined,
            status: params.get('status') ?? undefined,
            registered:
              params.get('registeredFrom') && params.get('registeredTo')
                ? [dayjs(params.get('registeredFrom')), dayjs(params.get('registeredTo'))]
                : undefined,
          }}
          style={{ rowGap: 12 }}
        >
          <Form.Item name="publicId" label="회원 ID">
            <Input placeholder="정확히 일치" allowClear style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="nickname" label="닉네임">
            <Input placeholder="앞부분 일치" allowClear style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="status" label="상태">
            <Select
              allowClear
              style={{ width: 110 }}
              placeholder="전체"
              options={[
                { value: 'ACTIVE', label: '정상' },
                { value: 'SUSPENDED', label: '정지' },
                { value: 'WITHDRAWN', label: '탈퇴' },
              ]}
            />
          </Form.Item>
          <Form.Item name="registered" label="가입일">
            <DatePicker.RangePicker />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
              검색
            </Button>
          </Form.Item>
          <Form.Item>
            <Button
              onClick={() => {
                form.resetFields();
                setParams({});
              }}
            >
              초기화
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card>
        <Table<UserSummary>
          rowKey="publicId"
          size="middle"
          loading={isFetching}
          dataSource={data?.data ?? []}
          pagination={{
            current: page,
            pageSize: size,
            total: data?.meta?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `총 ${fmtNumber(t)}명`,
            onChange: (p, s) => setParams({ ...query, page: String(p), size: String(s) }),
          }}
          columns={[
            {
              title: '회원 ID',
              dataIndex: 'publicId',
              render: (v: string) => <Link to={`/users/${v}`}>{v}</Link>,
            },
            { title: '닉네임', dataIndex: 'nickname' },
            { title: '레벨', dataIndex: 'level', align: 'right', width: 80 },
            {
              title: '상태',
              dataIndex: 'status',
              width: 100,
              render: (s: UserStatus) => <UserStatusTag status={s} />,
            },
            { title: '이메일', dataIndex: 'email' },
            { title: '가입일', dataIndex: 'registeredAt', render: fmtDateTime },
            { title: '최근 접속', dataIndex: 'lastLoginAt', render: fmtDateTime },
          ]}
        />
      </Card>
    </>
  );
}
