import { Tag } from 'antd';
import { CheckCircleOutlined, MinusCircleOutlined, StopOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { UserStatus } from '@game-admin/shared';

/** 상태는 색만이 아니라 아이콘 + 글자로 표시 */
const MAP: Record<UserStatus, { color: string; label: string; icon: ReactNode }> = {
  ACTIVE: { color: 'success', label: '정상', icon: <CheckCircleOutlined /> },
  SUSPENDED: { color: 'error', label: '정지', icon: <StopOutlined /> },
  WITHDRAWN: { color: 'default', label: '탈퇴', icon: <MinusCircleOutlined /> },
};

export function UserStatusTag({ status }: { status: UserStatus }) {
  const m = MAP[status] ?? MAP.ACTIVE;
  return (
    <Tag color={m.color} icon={m.icon}>
      {m.label}
    </Tag>
  );
}
