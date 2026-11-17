import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Result, Spin } from 'antd';
import type { Permission } from '@game-admin/shared';
import { useAuth } from './AuthProvider';

/** 로그인 필수. 임시 비밀번호 계정은 비밀번호 변경 화면으로 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (state.status === 'anonymous') {
    // 직접 로그아웃했으면 돌아갈 곳을 기억하지 않음 → 다시 로그인하면 대시보드
    const from = state.reason === 'logout' ? undefined : location.pathname + location.search;
    return <Navigate to="/login" replace state={from ? { from } : null} />;
  }
  if (state.me.mustChangePassword && location.pathname !== '/change-password')
    return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** 화면 단위 권한. 서버도 같은 권한을 검사하므로 이건 UX 용 */
export function RequirePermission({
  permissions,
  children,
}: {
  permissions: Permission[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(...permissions))
    return (
      <Result
        status="403"
        title="권한이 없습니다"
        subTitle={`필요한 권한: ${permissions.join(', ')}`}
      />
    );
  return <>{children}</>;
}

/** 버튼·메뉴 노출 제어 */
export function Can({ permissions, children }: { permissions: Permission[]; children: ReactNode }) {
  const { can } = useAuth();
  return can(...permissions) ? <>{children}</> : null;
}
