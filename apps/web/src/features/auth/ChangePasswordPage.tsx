import { Alert, App, Button, Card, Form, Input, Typography } from 'antd';
import { useNavigate } from 'react-router';
import { useAuth } from '../../shared/auth/AuthProvider';
import { api, ApiError, session } from '../../shared/api/client';

const policy = [
  { required: true, message: '새 비밀번호를 입력하세요.' },
  { min: 10, message: '10자 이상이어야 합니다.' },
  { max: 72, message: '72자 이하여야 합니다.' },
  { pattern: /[A-Za-z]/, message: '영문을 포함해야 합니다.' },
  { pattern: /[0-9]/, message: '숫자를 포함해야 합니다.' },
];

/** 변경하면 모든 세션이 종료되므로 다시 로그인한다 */
export function ChangePasswordPage() {
  const { me, logout } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm();

  async function onFinish(v: { currentPassword: string; newPassword: string }) {
    try {
      await api.patch('/auth/me/password', {
        currentPassword: v.currentPassword,
        newPassword: v.newPassword,
      });
      // 로그인 화면으로 먼저 이동한 뒤 로그아웃 (반대 순서면 로그인 가드가 이 화면을 '돌아갈 곳'으로 기억함)
      navigate('/login', { replace: true });
      session.set(null);
      await logout();
      void message.success('비밀번호를 변경했습니다. 새 비밀번호로 다시 로그인하세요.');
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '변경에 실패했습니다.');
    }
  }

  return (
    <div
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f5f6fa' }}
    >
      <Card style={{ width: 420 }}>
        <Typography.Title level={4}>비밀번호 변경</Typography.Title>
        {me?.mustChangePassword && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="임시 비밀번호로 로그인했습니다. 비밀번호를 변경해야 다른 기능을 쓸 수 있습니다."
          />
        )}
        <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            label="현재 비밀번호"
            name="currentPassword"
            rules={[{ required: true, message: '현재 비밀번호를 입력하세요.' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            label="새 비밀번호"
            name="newPassword"
            rules={policy}
            extra="10자 이상, 영문과 숫자 포함"
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            label="새 비밀번호 확인"
            name="confirm"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '한 번 더 입력하세요.' },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  v === getFieldValue('newPassword')
                    ? Promise.resolve()
                    : Promise.reject(new Error('일치하지 않습니다.')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            변경
          </Button>
          {!me?.mustChangePassword && (
            <Button type="link" block onClick={() => navigate(-1)} style={{ marginTop: 8 }}>
              돌아가기
            </Button>
          )}
        </Form>
      </Card>
    </div>
  );
}
