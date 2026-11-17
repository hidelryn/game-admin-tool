import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CheckOutlined, EditOutlined, KeyOutlined, MinusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import dayjs from 'dayjs';
import {
  RoleCode,
  type AdminDetail,
  type ApiTokenSummary,
  type Permission,
  type PermissionEffect,
  type RoleWithPermissions,
} from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { ReasonField } from '../../shared/components/ReasonField';
import { SecretOnce } from '../../shared/components/SecretOnce';
import { fmtDateTime } from '../../shared/format';
import { PERMISSION_GROUPS, PERMISSION_LABEL, ROLE_LABEL } from '../../shared/permission-labels';
import { AdminStatusTag } from './AdminsPage';
import { TokenStatusTag } from '../tokens/ApiTokensPage';

type OverrideChoice = 'ROLE' | PermissionEffect;

export function AdminDetailPage() {
  const { adminId = '' } = useParams();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'reset' | null>(null);

  const detail = useQuery({
    queryKey: ['admin', adminId],
    queryFn: async () => (await api.get<AdminDetail>(`/admins/${adminId}`)).data,
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await api.get<RoleWithPermissions[]>('/roles')).data,
    staleTime: 5 * 60_000,
  });

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return <Result status="404" title="운영자를 찾을 수 없습니다" />;
  }
  const a = detail.data;
  const isSelf = a?.id === me?.id;
  // 최고 관리자 계정은 최고 관리자만 관리 (서버 규칙과 동일)
  const locked =
    isSelf || (a?.roleCode === RoleCode.SUPER_ADMIN && me?.roleCode !== RoleCode.SUPER_ADMIN);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', adminId] });
    void queryClient.invalidateQueries({ queryKey: ['admins'] });
  };

  return (
    <>
      <PageHeader
        title={a?.name ?? `운영자 #${adminId}`}
        sub={a?.email}
        extra={
          a &&
          !locked && (
            <Space>
              <Button icon={<KeyOutlined />} onClick={() => setDialog('reset')}>
                비밀번호 초기화
              </Button>
              <Button icon={<EditOutlined />} onClick={() => setDialog('edit')}>
                정보·역할·상태 변경
              </Button>
            </Space>
          )
        }
      />
      {isSelf && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="본인 계정의 역할·권한·상태는 다른 관리자가 바꿔야 합니다."
        />
      )}
      {!isSelf && locked && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="최고 관리자 계정은 최고 관리자만 관리할 수 있습니다."
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={9}>
          <Card title="기본 정보">
            <Skeleton loading={detail.isLoading} active>
              {a && (
                <Descriptions column={1} size="small" bordered styles={{ label: { width: 100 } }}>
                  <Descriptions.Item label="역할">{ROLE_LABEL[a.roleCode]}</Descriptions.Item>
                  <Descriptions.Item label="상태">
                    <AdminStatusTag admin={a} />
                  </Descriptions.Item>
                  {a.lockedUntil && dayjs(a.lockedUntil).isAfter(dayjs()) && (
                    <Descriptions.Item label="잠금 해제">
                      {fmtDateTime(a.lockedUntil)} (로그인 실패 누적)
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="최근 로그인">
                    {fmtDateTime(a.lastLoginAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="생성일">{fmtDateTime(a.createdAt)}</Descriptions.Item>
                </Descriptions>
              )}
            </Skeleton>
          </Card>
          {a && <AdminTokens adminId={a.id} />}
        </Col>
        <Col xs={24} xl={15}>
          {a && roles.data ? (
            <PermissionMatrix admin={a} roles={roles.data} readOnly={locked} onSaved={refresh} />
          ) : (
            <Card title="권한">
              <Skeleton active />
            </Card>
          )}
        </Col>
      </Row>

      {a && (
        <>
          <EditAdminModal
            admin={a}
            open={dialog === 'edit'}
            onClose={() => setDialog(null)}
            onDone={refresh}
          />
          <ResetPasswordModal
            admin={a}
            open={dialog === 'reset'}
            onClose={() => setDialog(null)}
            onDone={refresh}
          />
        </>
      )}
    </>
  );
}

/**
 * 권한 표: 역할 기본 + 개별 설정(허용 GRANT / 차단 DENY) = 최종 권한
 * 최종 = 역할 ∪ 허용 − 차단 (서버 계산과 동일). 저장하면 해당 운영자의 기존 로그인 토큰은 즉시 무효
 */
function PermissionMatrix({
  admin,
  roles,
  readOnly,
  onSaved,
}: {
  admin: AdminDetail;
  roles: RoleWithPermissions[];
  readOnly: boolean;
  onSaved(): void;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  const { message } = App.useApp();
  const roleSet = useMemo(
    () => new Set(roles.find((r) => r.code === admin.roleCode)?.permissions ?? []),
    [roles, admin.roleCode],
  );
  const initial = useMemo(
    () =>
      Object.fromEntries(admin.overrides.map((o) => [o.permission, o.effect])) as Partial<
        Record<Permission, PermissionEffect>
      >,
    [admin.overrides],
  );
  const [choices, setChoices] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setChoices(initial), [initial]);

  const effective = (p: Permission) =>
    choices[p] === 'DENY' ? false : choices[p] === 'GRANT' ? true : roleSet.has(p);
  const dirty = JSON.stringify(choices) !== JSON.stringify(initial);

  async function save() {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const overrides = Object.entries(choices).map(([permission, effect]) => ({
        permission,
        effect,
      }));
      await api.put(`/admins/${admin.id}/permission-overrides`, { overrides, reason: v.reason });
      void message.success(
        '권한을 저장했습니다. 해당 운영자는 다음 요청부터 바뀐 권한이 적용됩니다.',
      );
      form.resetFields();
      onSaved();
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  const rows = PERMISSION_GROUPS.flatMap((g) =>
    g.permissions.map((p, i) => ({
      key: p,
      group: g.label,
      groupSpan: i === 0 ? g.permissions.length : 0,
    })),
  );

  return (
    <Card
      title="권한"
      extra={<Typography.Text type="secondary">최종 = 역할 기본 + 허용 − 차단</Typography.Text>}
    >
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        columns={[
          {
            title: '구분',
            dataIndex: 'group',
            width: 80,
            onCell: (r) => ({ rowSpan: r.groupSpan }),
          },
          {
            title: '권한',
            dataIndex: 'key',
            render: (p: Permission) => (
              <>
                {PERMISSION_LABEL[p]}{' '}
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {p}
                </Typography.Text>
              </>
            ),
          },
          {
            title: '역할 기본',
            width: 80,
            align: 'center',
            render: (_, r) =>
              roleSet.has(r.key) ? (
                <CheckOutlined style={{ color: '#1baf7a' }} />
              ) : (
                <MinusOutlined style={{ color: '#d9d9d9' }} />
              ),
          },
          {
            title: '개별 설정',
            width: 190,
            render: (_, r) => (
              <Segmented<OverrideChoice>
                size="small"
                disabled={readOnly}
                value={choices[r.key] ?? 'ROLE'}
                onChange={(v) =>
                  setChoices((c) => {
                    const next = { ...c };
                    if (v === 'ROLE') delete next[r.key];
                    else next[r.key] = v;
                    return next;
                  })
                }
                options={[
                  { value: 'ROLE', label: '기본' },
                  { value: 'GRANT', label: '허용' },
                  { value: 'DENY', label: '차단' },
                ]}
              />
            ),
          },
          {
            title: '최종',
            width: 70,
            align: 'center',
            render: (_, r) => (effective(r.key) ? <Tag color="green">O</Tag> : <Tag>X</Tag>),
          },
        ]}
      />
      {!readOnly && (
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <ReasonField label="변경 사유" />
          <Space>
            <Button type="primary" loading={saving} disabled={!dirty} onClick={save}>
              권한 저장
            </Button>
            <Button disabled={!dirty} onClick={() => setChoices(initial)}>
              되돌리기
            </Button>
          </Space>
        </Form>
      )}
    </Card>
  );
}

function EditAdminModal({
  admin,
  open,
  onClose,
  onDone,
}: {
  admin: AdminDetail;
  open: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const [form] = Form.useForm<{
    name: string;
    roleCode: RoleCode;
    status: string;
    reason: string;
  }>();
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();
  const { me } = useAuth();

  async function submit() {
    const v = await form.validateFields();
    const body: Record<string, unknown> = { reason: v.reason };
    if (v.name !== admin.name) body.name = v.name;
    if (v.roleCode !== admin.roleCode) body.roleCode = v.roleCode;
    if (v.status !== admin.status) body.status = v.status;
    if (Object.keys(body).length === 1) {
      void message.info('바뀐 내용이 없습니다.');
      return;
    }
    setLoading(true);
    try {
      await api.patch(`/admins/${admin.id}`, body);
      void message.success('변경했습니다.');
      onClose();
      onDone();
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '변경하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="정보·역할·상태 변경"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="변경"
      okButtonProps={{ loading }}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ name: admin.name, roleCode: admin.roleCode, status: admin.status }}
      >
        <Form.Item name="name" label="이름" rules={[{ required: true, min: 2, max: 50 }]}>
          <Input />
        </Form.Item>
        <Form.Item name="roleCode" label="역할">
          <Select
            options={Object.entries(ROLE_LABEL).map(([value, label]) => ({
              value,
              label,
              disabled: value === RoleCode.SUPER_ADMIN && me?.roleCode !== RoleCode.SUPER_ADMIN,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="status"
          label="상태"
          extra="비활성으로 바꾸면 즉시 로그아웃되고 API 토큰도 쓸 수 없습니다."
        >
          <Select
            options={[
              { value: 'ACTIVE', label: '사용' },
              { value: 'DISABLED', label: '비활성' },
            ]}
          />
        </Form.Item>
        <ReasonField />
      </Form>
    </Modal>
  );
}

function ResetPasswordModal({
  admin,
  open,
  onClose,
  onDone,
}: {
  admin: AdminDetail;
  open: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  const [loading, setLoading] = useState(false);
  const { message, modal } = App.useApp();

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    try {
      const { data } = await api.post<{ temporaryPassword: string }>(
        `/admins/${admin.id}/reset-password`,
        v,
      );
      onClose();
      onDone();
      modal.success({
        title: '비밀번호를 초기화했습니다',
        width: 480,
        content: (
          <SecretOnce
            label={`${admin.name}의 임시 비밀번호`}
            value={data.temporaryPassword}
            warning="본인에게 안전한 경로로 직접 전달하세요. 기존 로그인은 모두 끊겼고, 다음 로그인 때 새 비밀번호로 바꿔야 합니다."
          />
        ),
        okText: '전달했습니다',
      });
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '초기화하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="비밀번호 초기화"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="초기화"
      okButtonProps={{ danger: true, loading }}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="임시 비밀번호가 새로 발급되고 기존 로그인은 모두 끊깁니다"
        description="잠긴 계정(로그인 실패 누적)도 함께 풀립니다."
      />
      <Form form={form} layout="vertical" preserve={false}>
        <ReasonField />
      </Form>
    </Modal>
  );
}

/** 이 운영자가 발급한 API 토큰 — 관리자는 원문을 볼 수 없고 폐기만 할 수 있다 */
function AdminTokens({ adminId }: { adminId: number }) {
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const tokens = useQuery({
    queryKey: ['admin', String(adminId), 'tokens'],
    queryFn: async () => (await api.get<ApiTokenSummary[]>(`/admins/${adminId}/api-tokens`)).data,
  });

  function revoke(t: ApiTokenSummary) {
    let reason = '';
    void modal.confirm({
      title: `토큰 "${t.name}" 폐기`,
      content: (
        <>
          <Typography.Paragraph>
            폐기하면 이 토큰으로 연결된 MCP 클라이언트가 즉시 끊깁니다.
          </Typography.Paragraph>
          <Input.TextArea
            rows={2}
            placeholder="폐기 사유 (5자 이상)"
            onChange={(e) => (reason = e.target.value)}
          />
        </>
      ),
      okText: '폐기',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (reason.trim().length < 5) {
          void message.error('사유를 5자 이상 입력하세요.');
          throw new Error('reason');
        }
        try {
          await api.delete(`/admins/${adminId}/api-tokens/${t.id}`, { reason: reason.trim() });
          void message.success('폐기했습니다.');
          void queryClient.invalidateQueries({ queryKey: ['admin', String(adminId), 'tokens'] });
        } catch (err) {
          void message.error(err instanceof ApiError ? err.message : '폐기하지 못했습니다.');
        }
      },
    });
  }

  return (
    <Card title="발급한 API 토큰" style={{ marginTop: 16 }} size="small">
      <Table<ApiTokenSummary>
        rowKey="id"
        size="small"
        loading={tokens.isLoading}
        dataSource={tokens.data ?? []}
        pagination={false}
        locale={{
          emptyText: (
            <Empty description="발급한 토큰이 없습니다" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ),
        }}
        columns={[
          {
            title: '이름',
            dataIndex: 'name',
            render: (v: string, r) => (
              <>
                {v}
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ga_{r.prefix}_…
                </Typography.Text>
              </>
            ),
          },
          { title: '상태', width: 80, render: (_, r) => <TokenStatusTag token={r} /> },
          {
            title: '',
            width: 60,
            render: (_, r) =>
              !r.revokedAt && dayjs(r.expiresAt).isAfter(dayjs()) ? (
                <Button size="small" danger type="link" onClick={() => revoke(r)}>
                  폐기
                </Button>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}
