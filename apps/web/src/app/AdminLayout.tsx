import { Avatar, Button, Dropdown, Flex, Grid, Layout, Menu, Tag, Typography } from 'antd';
import {
  AuditOutlined,
  CalendarOutlined,
  DashboardOutlined,
  FundOutlined,
  SendOutlined,
  DollarOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LogoutOutlined,
  MailOutlined,
  RobotOutlined,
  NotificationOutlined,
  TeamOutlined,
  TrophyOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Permission } from '@game-admin/shared';
import { ROLE_LABEL } from '../shared/permission-labels';
import { useAuth } from '../shared/auth/AuthProvider';
import { MaintenanceBanner } from '../features/live-notices/MaintenanceBanner';
import { AssistantPanel } from '../features/assistant/AssistantPanel';

const { Sider, Header, Content } = Layout;

/** 메뉴는 권한에 따라 노출 (서버도 같은 권한을 검사) */
const MENU: { key: string; label: string; icon: ReactNode; permission?: Permission }[] = [
  {
    key: '/dashboard',
    label: '대시보드',
    icon: <DashboardOutlined />,
    permission: Permission.DASHBOARD_READ,
  },
  {
    key: '/analytics',
    label: '유저 분석',
    icon: <FundOutlined />,
    permission: Permission.ANALYTICS_READ,
  },
  { key: '/users', label: '회원 관리', icon: <TeamOutlined />, permission: Permission.USER_READ },
  {
    key: '/currencies',
    label: '재화 관리',
    icon: <DollarOutlined />,
    permission: Permission.CURRENCY_READ,
  },
  { key: '/mails', label: '우편 관리', icon: <MailOutlined />, permission: Permission.MAIL_READ },
  { key: '/emails', label: '이메일', icon: <SendOutlined />, permission: Permission.EMAIL_READ },
  {
    key: '/rankings',
    label: '랭킹',
    icon: <TrophyOutlined />,
    permission: Permission.RANKING_READ,
  },
  {
    key: '/schedules',
    label: '스케줄',
    icon: <CalendarOutlined />,
    permission: Permission.SCHEDULE_READ,
  },
  {
    key: '/live-notices',
    label: '점검·공지',
    icon: <NotificationOutlined />,
    permission: Permission.NOTICE_READ,
  },
  {
    key: '/audit-logs',
    label: '운영 로그',
    icon: <FileSearchOutlined />,
    permission: Permission.AUDIT_READ,
  },
  {
    key: '/admins',
    label: '운영자 관리',
    icon: <AuditOutlined />,
    permission: Permission.ADMIN_MANAGE,
  },
  {
    key: '/me/api-tokens',
    label: 'API 토큰',
    icon: <KeyOutlined />,
    permission: Permission.TOKEN_MANAGE_OWN,
  },
];

export function AdminLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { me, can, logout } = useAuth();
  const items = MENU.filter((m) => !m.permission || can(m.permission)).map(
    ({ key, label, icon }) => ({ key, icon, label }),
  );
  const selected = items.find((i) => pathname === i.key || pathname.startsWith(`${i.key}/`))?.key;
  const [assistantOpen, setAssistantOpen] = useState(false);
  // 넓은 화면은 본문 옆에 나란히, 좁은 화면은 본문 위에 겹쳐서
  const wide = Grid.useBreakpoint().xl ?? true;

  return (
    <Layout hasSider style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div style={{ padding: '20px 24px' }}>
          <Typography.Text strong style={{ color: '#fff', fontSize: 16 }}>
            Game Admin
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selected ? [selected] : []}
          items={items}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{ background: '#fff', paddingInline: 24, borderBottom: '1px solid #f0f0f0' }}
        >
          <Flex justify="flex-end" align="center" gap={8} style={{ height: '100%' }}>
            {me?.isDemo && (
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                체험 계정 · 매일 04:00 초기화
              </Tag>
            )}
            {can(Permission.ASSISTANT_USE) && (
              <Button
                type={assistantOpen ? 'primary' : 'text'}
                icon={<RobotOutlined />}
                onClick={() => setAssistantOpen((v) => !v)}
              >
                AI 어시스턴트
              </Button>
            )}
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'tokens',
                    icon: <KeyOutlined />,
                    label: 'API 토큰',
                    disabled: !can(Permission.TOKEN_MANAGE_OWN),
                  },
                  {
                    key: 'password',
                    icon: <UserOutlined />,
                    label: me?.isDemo ? '비밀번호 변경 (체험 계정 불가)' : '비밀번호 변경',
                    disabled: me?.isDemo,
                  },
                  { type: 'divider' },
                  { key: 'logout', icon: <LogoutOutlined />, label: '로그아웃', danger: true },
                ],
                onClick: async ({ key }) => {
                  if (key === 'logout') {
                    await logout();
                    navigate('/login', { replace: true });
                  } else if (key === 'password') navigate('/change-password');
                  else if (key === 'tokens') navigate('/me/api-tokens');
                },
              }}
            >
              <Button type="text" style={{ height: 48 }}>
                <Avatar size="small" icon={<UserOutlined />} />
                <span>{me?.name}</span>
                <Tag style={{ marginInlineEnd: 0 }}>{me ? ROLE_LABEL[me.roleCode] : ''}</Tag>
              </Button>
            </Dropdown>
          </Flex>
        </Header>
        <MaintenanceBanner />
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
      {assistantOpen && (
        <div
          style={
            wide
              ? { alignSelf: 'flex-start', position: 'sticky', top: 0, zIndex: 10 }
              : {
                  position: 'fixed',
                  top: 0,
                  right: 0,
                  zIndex: 1000,
                  maxWidth: '100vw',
                  boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
                }
          }
        >
          <AssistantPanel onClose={() => setAssistantOpen(false)} />
        </div>
      )}
    </Layout>
  );
}
