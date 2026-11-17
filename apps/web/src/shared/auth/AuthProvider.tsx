import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LoginResponse, MeResponse, Permission } from '@game-admin/shared';
import { api, refreshAccessToken, session } from '../api/client';

/**
 * anonymous.reason
 * - logout: 사용자가 직접 로그아웃 → 다시 로그인하면 첫 화면(대시보드)
 * - expired: 세션 만료·갱신 실패 → 다시 로그인하면 보던 화면으로 복귀
 * - initial: 앱을 열었을 때 로그인 안 된 상태
 */
type AnonymousReason = 'initial' | 'logout' | 'expired';
type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous'; reason: AnonymousReason }
  | { status: 'authenticated'; me: MeResponse };

interface AuthContextValue {
  state: AuthState;
  me: MeResponse | null;
  login(email: string, password: string): Promise<MeResponse>;
  logout(): Promise<void>;
  reload(): Promise<void>;
  can(...permissions: Permission[]): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * 앱 시작 시 refresh 쿠키로 세션 복구 → /auth/me 로 권한 목록 확보.
 * 권한은 메뉴·버튼 노출에만 쓰고, 실제 검사는 항상 서버가 한다.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const queryClient = useQueryClient();

  const loadMe = useCallback(async () => {
    const { data } = await api.get<MeResponse>('/auth/me');
    setState({ status: 'authenticated', me: data });
  }, []);

  useEffect(() => {
    let alive = true;
    refreshAccessToken()
      .then((ok) => (ok ? loadMe() : alive && setState({ status: 'anonymous', reason: 'initial' })))
      .catch(() => alive && setState({ status: 'anonymous', reason: 'initial' }));
    const off = session.onEnd(() => {
      queryClient.clear();
      setState({ status: 'anonymous', reason: 'expired' });
    });
    return () => {
      alive = false;
      off();
    };
  }, [loadMe, queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const me = state.status === 'authenticated' ? state.me : null;
    return {
      state,
      me,
      async login(email, password) {
        const { data } = await api.post<LoginResponse>('/auth/login', { email, password });
        session.set(data.accessToken);
        setState({ status: 'authenticated', me: data.admin });
        return data.admin;
      },
      async logout() {
        await api.post('/auth/logout').catch(() => undefined);
        session.set(null);
        queryClient.clear();
        setState({ status: 'anonymous', reason: 'logout' });
      },
      reload: loadMe,
      can: (...permissions) => !!me && permissions.every((p) => me.permissions.includes(p)),
    };
  }, [state, loadMe, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
