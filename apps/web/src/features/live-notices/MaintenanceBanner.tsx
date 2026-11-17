import { Alert, Button } from 'antd';
import { useNavigate } from 'react-router';
import dayjs from 'dayjs';
import { Permission } from '@game-admin/shared';
import { useAuth } from '../../shared/auth/AuthProvider';
import { remain, useCurrentMaintenance } from './common';

/**
 * 모든 운영자 화면 상단: 게임 점검 중 표시
 * (점검 중인 줄 모르고 작업하거나, 끝난 줄 알고 공지하는 실수 방지)
 */
export function MaintenanceBanner() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const current = useCurrentMaintenance();
  const m = current.data;
  if (!m?.active || !m.endsAt) return null;
  return (
    <Alert
      type="error"
      banner
      showIcon
      message={
        <>
          <b>게임 점검 중</b> (~{dayjs(m.endsAt).format('MM/DD HH:mm')}, {remain(m.endsAt)} 남음) —{' '}
          {m.title}
        </>
      }
      action={
        can(Permission.NOTICE_READ) && (
          <Button size="small" onClick={() => navigate('/live-notices?tab=maintenance')}>
            점검 보기
          </Button>
        )
      }
    />
  );
}
