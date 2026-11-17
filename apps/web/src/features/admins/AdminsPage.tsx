import { useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Select, Table, Tag, Typography } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { RoleCode, type AdminSummary, type CreatedAdmin } from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { SecretOnce } from '../../shared/components/SecretOnce';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { ROLE_LABEL } from '../../shared/permission-labels';

export function AdminStatusTag({
  admin,
}: {
  admin: Pick<AdminSummary, 'status' | 'lockedUntil' | 'mustChangePassword'>;
}) {
  return (
    <>
      {admin.status === 'ACTIVE' ? <Tag color="green">사용</Tag> : <Tag>비활성</Tag>}
      {admin.lockedUntil && dayjs(admin.lockedUntil).isAfter(dayjs()) && (
        <Tag color="red">잠김</Tag>
      )}
      {admin.mustChangePassword && <Tag color="orange">비번 변경 필요</Tag>}
    </>
  );
}

/** 운영자 관리 (admin:manage) */
export function AdminsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const query = Object.fromEntries(params.entries());
  const page = Number(params.get('page') ?? 1);

  const { data, isFetching } = useQuery({
    queryKey: ['admins', query],
    queryFn: () => api.get<AdminSummary[]>('/admins', { size: 20, ...query }),
    placeholderData: keepPreviousData,
  });

  const set = (k: string, v?: string) => {
    const next = { ...query };
    delete next.page;
    if (v) next[k] = v;
    else delete next[k];
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title="운영자 관리"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            운영자 추가
          </Button>
        }
      />
      <Card>
        <Input.Search
          placeholder="이름·이메일"
          allowClear
          defaultValue={params.get('q') ?? ''}
          enterButton={<SearchOutlined />}
          style={{ width: 260, marginRight: 8, marginBottom: 12 }}
          onSearch={(v) => set('q', v.trim() || undefined)}
        />
        <Select
          placeholder="역할"
          allowClear
          style={{ width: 130, marginRight: 8 }}
          value={params.get('roleCode') ?? undefined}
          onChange={(v) => set('roleCode', v)}
          options={Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <Select
          placeholder="상태"
          allowClear
          style={{ width: 110 }}
          value={params.get('status') ?? undefined}
          onChange={(v) => set('status', v)}
          options={[
            { value: 'ACTIVE', label: '사용' },
            { value: 'DISABLED', label: '비활성' },
          ]}
        />
        <Table<AdminSummary>
          rowKey="id"
          size="small"
          loading={isFetching}
          dataSource={data?.data ?? []}
          onRow={(r) => ({
            onClick: () => navigate(`/admins/${r.id}`),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: page,
            pageSize: 20,
            total: Number(data?.meta?.total ?? 0),
            showSizeChanger: false,
            showTotal: (n) => `${fmtNumber(n)}명`,
            onChange: (p) => setParams({ ...query, page: String(p) }),
          }}
          columns={[
            {
              title: '이름',
              dataIndex: 'name',
              render: (v: string, r) => (
                <Link to={`/admins/${r.id}`} onClick={(e) => e.stopPropagation()}>
                  {v}
                </Link>
              ),
            },
            { title: '이메일', dataIndex: 'email' },
            {
              title: '역할',
              dataIndex: 'roleCode',
              width: 120,
              render: (r: RoleCode) => (
                <Tag color={r === RoleCode.SUPER_ADMIN ? 'red' : 'blue'}>{ROLE_LABEL[r]}</Tag>
              ),
            },
            { title: '상태', width: 220, render: (_, r) => <AdminStatusTag admin={r} /> },
            { title: '최근 로그인', dataIndex: 'lastLoginAt', width: 150, render: fmtDateTime },
            { title: '생성일', dataIndex: 'createdAt', width: 150, render: fmtDateTime },
          ]}
        />
      </Card>
      <CreateAdminModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

/** 운영자 추가 → 임시 비밀번호를 한 번만 보여준다 (첫 로그인 때 변경 강제) */
function CreateAdminModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [form] = Form.useForm<{ email: string; name: string; roleCode: RoleCode }>();
  const [loading, setLoading] = useState(false);
  const { modal, message } = App.useApp();
  const { me } = useAuth();
  const queryClient = useQueryClient();

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    try {
      const { data } = await api.post<CreatedAdmin>('/admins', v);
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
      onClose();
      form.resetFields();
      modal.success({
        title: `${v.name} 운영자를 추가했습니다`,
        width: 480,
        content: (
          <SecretOnce
            label="임시 비밀번호"
            value={data.temporaryPassword}
            warning="본인에게 안전한 경로로 직접 전달하세요(메신저 단체방·이메일 본문 금지). 첫 로그인 때 새 비밀번호로 바꿔야 합니다."
          />
        ),
        okText: '전달했습니다',
      });
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '추가하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="운영자 추가"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="추가"
      okButtonProps={{ loading }}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ roleCode: RoleCode.VIEWER }}
      >
        <Form.Item
          name="email"
          label="이메일"
          rules={[{ required: true, type: 'email', message: '이메일 형식이 아닙니다.' }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="name"
          label="이름"
          rules={[{ required: true, min: 2, max: 50, message: '2~50자' }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="roleCode"
          label="역할"
          extra="권한은 역할 기본값으로 시작하고, 상세 화면에서 개별로 더하거나 뺄 수 있습니다."
        >
          <Select
            options={Object.entries(ROLE_LABEL).map(([value, label]) => ({
              value,
              label,
              // 최고 관리자 계정은 최고 관리자만 만들 수 있음 (서버 규칙과 동일)
              disabled: value === RoleCode.SUPER_ADMIN && me?.roleCode !== RoleCode.SUPER_ADMIN,
            }))}
          />
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          처음 권한은 가장 적은 역할(조회 전용)로 두고 필요한 만큼 올리는 것을 권장합니다.
        </Typography.Text>
      </Form>
    </Modal>
  );
}
