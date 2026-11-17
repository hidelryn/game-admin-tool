import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';

export function PageHeader({
  title,
  extra,
  sub,
}: {
  title: ReactNode;
  extra?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <Flex justify="space-between" align="center" style={{ marginBottom: 16 }} wrap gap={8}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {sub && <Typography.Text type="secondary">{sub}</Typography.Text>}
      </div>
      {extra}
    </Flex>
  );
}
