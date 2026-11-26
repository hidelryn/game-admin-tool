import { Space, Tag, Tooltip, Typography } from 'antd';
import type { EmailCampaignStatus, EmailCounts, EmailDeliveryStatus } from '@game-admin/shared';
import { fmtNumber } from '../../shared/format';

export const CAMPAIGN_STATUS: Record<EmailCampaignStatus, { label: string; color: string }> = {
  SCHEDULED: { label: '예약', color: 'blue' },
  SENDING: { label: '발송 중', color: 'processing' },
  DONE: { label: '완료', color: 'green' },
  CANCELED: { label: '취소', color: 'default' },
};

export const DELIVERY_STATUS: Record<
  EmailDeliveryStatus,
  { label: string; color: string; tip: string }
> = {
  SENT: { label: '실제 발송', color: 'green', tip: 'SMTP 로 실제 보냄' },
  VIRTUAL: {
    label: '가상 발송',
    color: 'default',
    tip: '가상 주소·체험 계정 회원 대상 발송·SMTP 미설정 — 기록만 남김',
  },
  SKIPPED_NO_CONSENT: { label: '수신 거부', color: 'orange', tip: '광고성 메일 수신 동의 안 함' },
  SKIPPED_NIGHT: { label: '야간 제외', color: 'orange', tip: '야간(21~08시) 광고 수신 동의 안 함' },
  SKIPPED_INACTIVE: { label: '정지·탈퇴', color: 'default', tip: '활동 중인 회원이 아님' },
  FAILED: { label: '실패', color: 'red', tip: 'SMTP 오류·하루 발송 한도 초과' },
};

export function CampaignStatusTag({ status }: { status: EmailCampaignStatus }) {
  const s = CAMPAIGN_STATUS[status];
  return <Tag color={s.color}>{s.label}</Tag>;
}

export function DeliveryStatusTag({ status }: { status: EmailDeliveryStatus }) {
  const s = DELIVERY_STATUS[status];
  return (
    <Tooltip title={s.tip}>
      <Tag color={s.color}>{s.label}</Tag>
    </Tooltip>
  );
}

/** 결과 요약: 실제 · 가상 · 제외 · 실패 */
export function CountsText({ c }: { c: EmailCounts }) {
  if (!c.total) return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <Space size={4} wrap style={{ fontSize: 12 }}>
      <span>실제 {fmtNumber(c.sent)}</span>
      <Typography.Text type="secondary">·</Typography.Text>
      <span>가상 {fmtNumber(c.virtual)}</span>
      <Typography.Text type="secondary">·</Typography.Text>
      <span>제외 {fmtNumber(c.skipped)}</span>
      {c.failed > 0 && (
        <>
          <Typography.Text type="secondary">·</Typography.Text>
          <Typography.Text type="danger">실패 {fmtNumber(c.failed)}</Typography.Text>
        </>
      )}
    </Space>
  );
}
