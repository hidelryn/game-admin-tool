import { createBrowserRouter, Navigate } from 'react-router';
import { Permission } from '@game-admin/shared';
import { AdminLayout } from './AdminLayout';
import { RequireAuth, RequirePermission } from '../shared/auth/guards';
import { LoginPage } from '../features/auth/LoginPage';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { UsersPage } from '../features/users/UsersPage';
import { UserDetailPage } from '../features/users/UserDetailPage';
import { CurrenciesPage } from '../features/currencies/CurrenciesPage';
import { MailsPage } from '../features/mails/MailsPage';
import { MailComposePage } from '../features/mails/MailComposePage';
import { MailDetailPage } from '../features/mails/MailDetailPage';
import { RankingsPage } from '../features/rankings/RankingsPage';
import { AuditLogsPage } from '../features/audit/AuditLogsPage';
import { AdminsPage } from '../features/admins/AdminsPage';
import { AdminDetailPage } from '../features/admins/AdminDetailPage';
import { ApiTokensPage } from '../features/tokens/ApiTokensPage';
import { SchedulesPage } from '../features/schedules/SchedulesPage';
import { LiveNoticesPage } from '../features/live-notices/LiveNoticesPage';
import { RouteError } from './RouteError';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AdminLayout />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      {
        path: 'dashboard',
        element: (
          <RequirePermission permissions={[Permission.DASHBOARD_READ]}>
            <DashboardPage />
          </RequirePermission>
        ),
      },
      {
        path: 'users',
        element: (
          <RequirePermission permissions={[Permission.USER_READ]}>
            <UsersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'users/:publicId',
        element: (
          <RequirePermission permissions={[Permission.USER_READ]}>
            <UserDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'currencies',
        element: (
          <RequirePermission permissions={[Permission.CURRENCY_READ]}>
            <CurrenciesPage />
          </RequirePermission>
        ),
      },
      {
        path: 'mails',
        element: (
          <RequirePermission permissions={[Permission.MAIL_READ]}>
            <MailsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'mails/new',
        element: (
          <RequirePermission permissions={[Permission.MAIL_SEND]}>
            <MailComposePage />
          </RequirePermission>
        ),
      },
      {
        path: 'mails/:mailId',
        element: (
          <RequirePermission permissions={[Permission.MAIL_READ]}>
            <MailDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'rankings',
        element: (
          <RequirePermission permissions={[Permission.RANKING_READ]}>
            <RankingsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'schedules',
        element: (
          <RequirePermission permissions={[Permission.SCHEDULE_READ]}>
            <SchedulesPage />
          </RequirePermission>
        ),
      },
      {
        path: 'live-notices',
        element: (
          <RequirePermission permissions={[Permission.NOTICE_READ]}>
            <LiveNoticesPage />
          </RequirePermission>
        ),
      },
      {
        path: 'audit-logs',
        element: (
          <RequirePermission permissions={[Permission.AUDIT_READ]}>
            <AuditLogsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'admins',
        element: (
          <RequirePermission permissions={[Permission.ADMIN_MANAGE]}>
            <AdminsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'admins/:adminId',
        element: (
          <RequirePermission permissions={[Permission.ADMIN_MANAGE]}>
            <AdminDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'me/api-tokens',
        element: (
          <RequirePermission permissions={[Permission.TOKEN_MANAGE_OWN]}>
            <ApiTokensPage />
          </RequirePermission>
        ),
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
