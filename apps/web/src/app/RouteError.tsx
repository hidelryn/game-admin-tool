import { Button, Result } from 'antd';
import { useNavigate, useRouteError } from 'react-router';

export function RouteError() {
  const error = useRouteError() as Error | undefined;
  const navigate = useNavigate();
  return (
    <Result
      status="error"
      title="화면을 표시하지 못했습니다"
      subTitle={error?.message}
      extra={<Button onClick={() => navigate('/')}>처음으로</Button>}
    />
  );
}
