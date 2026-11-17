import { Result } from 'antd';

export function ComingSoon({ title }: { title: string }) {
  return <Result status="info" title={title} subTitle="다음 단계(Phase 4-2)에서 구현됩니다." />;
}
