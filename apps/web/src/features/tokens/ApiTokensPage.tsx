import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_DAYS,
  TOKEN_ASSIGNABLE_PERMISSIONS,
  type ApiTokenSummary,
  type CreatedApiToken,
  type Permission,
} from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { SecretOnce } from '../../shared/components/SecretOnce';
import { fmtDateTime } from '../../shared/format';
import { PERMISSION_GROUPS, PERMISSION_LABEL } from '../../shared/permission-labels';

const isActive = (t: ApiTokenSummary) => !t.revokedAt && dayjs(t.expiresAt).isAfter(dayjs());

export function TokenStatusTag({ token }: { token: ApiTokenSummary }) {
  if (token.revokedAt) return <Tag>폐기</Tag>;
  if (dayjs(token.expiresAt).isBefore(dayjs())) return <Tag color="orange">만료</Tag>;
  return <Tag color="green">사용 중</Tag>;
}

/**
 * 내 API 토큰 (MCP 연결용)
 * - 토큰 권한 = 고른 권한 ∩ 내 현재 권한 (내 권한이 줄면 토큰도 같이 줄어듦)
 * - 개인정보 원문·운영자 관리·토큰 관리는 토큰에 줄 수 없음
 * - 원문은 발급 직후 한 번만 보여주고 서버엔 해시만 저장
 */
export function ApiTokensPage() {
  const { me } = useAuth();
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const tokens = useQuery({
    queryKey: ['me', 'api-tokens'],
    queryFn: async () => (await api.get<ApiTokenSummary[]>('/me/api-tokens')).data,
  });
  const activeCount = tokens.data?.filter(isActive).length ?? 0;

  async function revoke(t: ApiTokenSummary) {
    const ok = await modal.confirm({
      title: `토큰 "${t.name}" 폐기`,
      content: '폐기하면 이 토큰을 쓰는 MCP 클라이언트가 즉시 끊기고, 되살릴 수 없습니다.',
      okText: '폐기',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    try {
      await api.delete(`/me/api-tokens/${t.id}`);
      void message.success('폐기했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['me', 'api-tokens'] });
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '폐기하지 못했습니다.');
    }
  }

  return (
    <>
      <PageHeader
        title="API 토큰"
        sub="MCP 클라이언트(Claude 등)가 내 권한 범위 안에서 백오피스 API 를 쓰게 하는 열쇠입니다"
        extra={
          <Tooltip
            title={
              activeCount >= API_TOKEN_MAX_ACTIVE
                ? `사용 중인 토큰은 ${API_TOKEN_MAX_ACTIVE}개까지입니다`
                : undefined
            }
          >
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={activeCount >= API_TOKEN_MAX_ACTIVE || me?.isDemo}
              onClick={() => setCreateOpen(true)}
            >
              토큰 발급
            </Button>
          </Tooltip>
        }
      />
      {me?.isDemo && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="체험 계정은 API 토큰을 발급할 수 없습니다"
          description="공개 계정이라 토큰이 새어 나가지 않도록 막아 두었습니다. AI(MCP) 연결 방식은 README 의 'MCP 서버 연결'을 참고하세요."
        />
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="토큰으로 할 수 있는 일은 '고른 권한'과 '내 현재 권한'이 겹치는 만큼입니다"
        description="회수·유료 재화 지급 같은 위험 작업은 토큰으로도 실행 전 확인을 거치고, 대량 지급·전체 우편·랭킹 초기화/복원/보상 같은 대규모 작업은 토큰으로는 미리보기만 되고 실행은 웹에서 사람이 합니다. 토큰을 쓴 모든 작업은 운영 로그에 MCP 로 남습니다."
      />
      <Card>
        <Table<ApiTokenSummary>
          rowKey="id"
          size="small"
          loading={tokens.isLoading}
          dataSource={tokens.data ?? []}
          pagination={false}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="발급한 토큰이 없습니다" /> }}
          columns={[
            {
              title: '이름',
              dataIndex: 'name',
              width: 180,
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
            {
              title: '권한',
              dataIndex: 'permissions',
              render: (ps: Permission[]) =>
                ps.map((p) => (
                  <Tag key={p} style={{ marginBottom: 2 }}>
                    {PERMISSION_LABEL[p]}
                  </Tag>
                )),
            },
            { title: '상태', width: 80, render: (_, r) => <TokenStatusTag token={r} /> },
            { title: '만료', dataIndex: 'expiresAt', width: 140, render: fmtDateTime },
            {
              title: '마지막 사용',
              dataIndex: 'lastUsedAt',
              width: 140,
              render: (v: string | null) => (v ? fmtDateTime(v) : '사용 안 함'),
            },
            {
              title: '',
              width: 70,
              render: (_, r) =>
                isActive(r) ? (
                  <Button size="small" danger type="link" onClick={() => revoke(r)}>
                    폐기
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <CreateTokenModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function CreateTokenModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [form] = Form.useForm<{ name: string; permissions: Permission[]; expiresInDays: number }>();
  const [loading, setLoading] = useState(false);
  const { modal, message } = App.useApp();
  const { can } = useAuth();
  const queryClient = useQueryClient();

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    try {
      const { data } = await api.post<CreatedApiToken>('/me/api-tokens', v);
      void queryClient.invalidateQueries({ queryKey: ['me', 'api-tokens'] });
      onClose();
      form.resetFields();
      modal.success({
        title: `토큰 "${data.name}"을 발급했습니다`,
        width: 560,
        content: (
          <>
            <SecretOnce
              label="토큰"
              value={data.token}
              warning="비밀번호처럼 다루세요. 코드·저장소·채팅에 붙여넣지 말고, MCP 클라이언트 설정(환경변수)에만 넣으세요. 잃어버리면 폐기하고 새로 발급하면 됩니다."
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              요청 헤더: <code>Authorization: Bearer &lt;토큰&gt;</code> · 만료{' '}
              {fmtDateTime(data.expiresAt)}
            </Typography.Text>
          </>
        ),
        okText: '안전하게 보관했습니다',
      });
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '발급하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="API 토큰 발급"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="발급"
      okButtonProps={{ loading }}
      width={600}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ expiresInDays: 30, permissions: [] }}
      >
        <Form.Item
          name="name"
          label="이름"
          rules={[{ required: true, min: 2, max: 50, message: '2~50자' }]}
          extra="어디서 쓰는 토큰인지 알 수 있게 (예: 내 노트북 Claude Desktop)"
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="permissions"
          label="권한"
          rules={[{ required: true, type: 'array', min: 1, message: '권한을 하나 이상 고르세요.' }]}
          extra="필요한 최소한만 고르세요. 회색은 내 권한에 없거나 토큰에 줄 수 없는 권한입니다."
        >
          <Checkbox.Group style={{ width: '100%' }}>
            <Row gutter={[8, 4]}>
              {PERMISSION_GROUPS.flatMap((g) => g.permissions).map((p) => {
                const assignable = TOKEN_ASSIGNABLE_PERMISSIONS.includes(p);
                const mine = can(p);
                return (
                  <Col span={12} key={p}>
                    <Tooltip
                      title={
                        !assignable
                          ? '토큰에 줄 수 없는 권한 (웹에서 사람만 수행)'
                          : !mine
                            ? '내 권한에 없음'
                            : undefined
                      }
                    >
                      <Checkbox value={p} disabled={!assignable || !mine}>
                        {PERMISSION_LABEL[p]}
                      </Checkbox>
                    </Tooltip>
                  </Col>
                );
              })}
            </Row>
          </Checkbox.Group>
        </Form.Item>
        <Form.Item
          name="expiresInDays"
          label="유효기간"
          rules={[{ required: true, type: 'number', min: 1, max: API_TOKEN_MAX_DAYS }]}
        >
          <InputNumber<number>
            min={1}
            max={API_TOKEN_MAX_DAYS}
            addonAfter="일"
            style={{ width: 140 }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
