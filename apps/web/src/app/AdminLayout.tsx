import { Avatar, Button, Dropdown, Flex, Layout, Menu, Tag, Typography } from 'antd';
import {
  AuditOutlined,
  CalendarOutlined,
  DashboardOutlined,
  DollarOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LogoutOutlined,
  MailOutlined,
  NotificationOutlined,
  TeamOutlined,
  TrophyOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Permission } from '@game-admin/shared';
import { ROLE_LABEL } from '../shared/permission-labels';
import { useAuth } from '../shared/auth/AuthProvider';
import { MaintenanceBanner } from '../features/live-notices/MaintenanceBanner';

const { Sider, Header, Content } = Layout;

/** 메뉴는 권한에 따라 노출 (서버도 같은 권한을 검사) */
const MENU: { key: string; label: string; icon: ReactNode; permission?: Permission }[] = [
  {
    key: '/dashboard',
    label: '대시보드',
    icon: <DashboardOutlined />,
    permission: Permission.DASHBOARD_READ,
  },
  { key: '/users', label: '회원 관리', icon: <TeamOutlined />, permission: Permission.USER_READ },
  {
    key: '/currencies',
    label: '재화 관리',
    icon: <DollarOutlined />,
    permission: Permission.CURRENCY_READ,
  },
  { key: '/mails', label: '우편 관리', icon: <MailOutlined />, permission: Permission.MAIL_READ },
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

  return (
    <Layout style={{ minHeight: '100vh' }}>
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
          <Flex justify="flex-end" align="center" style={{ height: '100%' }}>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'tokens',
                    icon: <KeyOutlined />,
                    label: 'API 토큰',
                    disabled: !can(Permission.TOKEN_MANAGE_OWN),
                  },
                  { key: 'password', icon: <UserOutlined />, label: '비밀번호 변경' },
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
    </Layout>
  );
}
