import { ConfigProvider, App as AntApp } from 'antd';
import koKR from 'antd/locale/ko_KR';
import dayjs from 'dayjs';
import 'dayjs/locale/ko';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { ApiError } from '../shared/api/client';
import { AuthProvider } from '../shared/auth/AuthProvider';
import { router } from './router';

dayjs.locale('ko');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx(권한·검증·없음)는 재시도해도 같은 결과 → 재시도하지 않음
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export function App() {
  return (
    <ConfigProvider locale={koKR} theme={{ token: { colorPrimary: '#2a78d6', borderRadius: 6 } }}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
