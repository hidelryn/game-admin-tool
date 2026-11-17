import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ApiError } from '../../shared/api/client';
import { safeReturnPath } from '../../shared/auth/return-path';

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const from = safeReturnPath((location.state as { from?: string } | null)?.from);

  if (state.status === 'authenticated') return <Navigate to={from} replace />;

  async function onFinish(v: { email: string; password: string }) {
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

  return (
    <div
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f5f6fa' }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: 'center', marginBottom: 24 }}>
          Game Admin
        </Typography.Title>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
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
    </div>
  );
}
