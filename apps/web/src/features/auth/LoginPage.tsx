import { useState } from 'react';
import { Alert, Button, Card, Divider, Flex, Form, Input, Typography } from 'antd';
import { LockOutlined, MailOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate } from 'react-router';
import dayjs from 'dayjs';
import type { DemoInfo } from '@game-admin/shared';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ApiError, api } from '../../shared/api/client';
import { safeReturnPath } from '../../shared/auth/return-path';

interface LoginValues {
  email: string;
  password: string;
}

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm<LoginValues>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const from = safeReturnPath((location.state as { from?: string } | null)?.from);

  // 체험 계정 안내 (체험 모드가 꺼져 있으면 enabled=false → 카드 숨김)
  const demo = useQuery({
    queryKey: ['public-demo'],
    queryFn: async () => (await api.get<DemoInfo>('/public/demo')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (state.status === 'authenticated') return <Navigate to={from} replace />;

  async function onFinish(v: LoginValues) {
    setLoading(true);
    setError(null);
    try {
      const me = await login(v.email, v.password);
      navigate(me.mustChangePassword ? '/change-password' : from, { replace: true });
    } catch (err) {
      // 잠금·횟수 제한·자격 증명 오류 모두 서버 메시지를 그대로 보여준다
      setError(err instanceof ApiError ? err.message : '로그인 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  const account = demo.data?.enabled ? demo.data.accounts[0] : undefined;

  return (
    <div style={{ minHeight: '100vh', background: '#eef1f8', display: 'flex' }}>
      <Flex
        wrap
        justify="center"
        align="center"
        gap={48}
        style={{ margin: 'auto', padding: '32px 16px', maxWidth: 1080, width: '100%' }}
      >
        {/* 로그인 */}
        <Flex vertical gap={16} style={{ flex: '0 1 380px', width: 380, maxWidth: '100%' }}>
          <Card>
            <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 20 }}>
              로그인
            </Typography.Title>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
            <Form<LoginValues>
              form={form}
              layout="vertical"
              onFinish={onFinish}
              requiredMark={false}
            >
              <Form.Item
                label="이메일"
                name="email"
                rules={[{ required: true, type: 'email', message: '이메일을 입력하세요.' }]}
              >
                <Input prefix={<MailOutlined />} autoComplete="username" autoFocus />
              </Form.Item>
              <Form.Item
                label="비밀번호"
                name="password"
                rules={[{ required: true, message: '비밀번호를 입력하세요.' }]}
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                로그인
              </Button>
            </Form>
          </Card>

          {account && (
            <Card size="small" style={{ borderColor: '#adc6ff', background: '#f5f8ff' }}>
              <Typography.Text strong>체험 계정</Typography.Text>
              <Typography.Text type="secondary"> · {account.roleName} 권한</Typography.Text>
              <Divider style={{ margin: '8px 0' }} />
              <Flex vertical gap={2} style={{ fontFamily: 'monospace' }}>
                <Typography.Text copyable>{account.email}</Typography.Text>
                <Typography.Text copyable>{account.password}</Typography.Text>
              </Flex>
              <Button
                icon={<ThunderboltOutlined />}
                block
                style={{ marginTop: 10 }}
                onClick={() => {
                  form.setFieldsValue({ email: account.email, password: account.password });
                  void form.submit();
                }}
              >
                체험 계정으로 로그인
              </Button>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
                누구나 같은 계정을 씁니다. 지급·우편·공지·점검 등을 직접 해 볼 수 있고, 데이터는
                {demo.data?.nextResetAt
                  ? ` 매일 ${dayjs(demo.data.nextResetAt).format('HH:mm')}에 처음 상태로 돌아갑니다.`
                  : ' 주기적으로 처음 상태로 돌아갑니다.'}{' '}
                비밀번호 변경은 막혀 있고, AI(MCP) 연결용 토큰은 조회 권한으로만 발급됩니다.
              </Typography.Paragraph>
            </Card>
          )}
        </Flex>
      </Flex>
    </div>
  );
}
