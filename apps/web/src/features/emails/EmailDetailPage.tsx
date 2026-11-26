import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Segmented,
  Table,
  Tag,
  Typography,
} from 'antd';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Permission,
  type EmailCampaignDetail,
  type EmailDeliveryItem,
  type EmailDeliveryStatus,
} from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { CampaignStatusTag, CountsText, DELIVERY_STATUS, DeliveryStatusTag } from './common';

export function EmailDetailPage() {
  const id = Number(useParams().campaignId);
  const { can } = useAuth();
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EmailDeliveryStatus | 'ALL'>('ALL');
  const [page, setPage] = useState(1);

  const detail = useQuery({
    queryKey: ['emails', 'detail', id],
    queryFn: async () => (await api.get<EmailCampaignDetail>(`/emails/${id}`)).data,
    refetchInterval: (q) =>
      q.state.data?.status === 'SENDING' || q.state.data?.status === 'SCHEDULED' ? 5_000 : false,
  });
  const deliveries = useQuery({
    queryKey: ['emails', 'deliveries', id, status, page, detail.data?.status],
    queryFn: async () => {
      const res = await api.get<EmailDeliveryItem[]>(`/emails/${id}/deliveries`, {
        page,
        size: 20,
        ...(status === 'ALL' ? {} : { status }),
      });
      return { items: res.data, total: (res.meta?.total as number | undefined) ?? 0 };
    },
    placeholderData: keepPreviousData,
  });
  const c = detail.data;

  async function cancel() {
    let reason = '';
    const ok = await modal.confirm({
      title: '예약 발송 취소',
      content: (
        <Form layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="사유 (5자 이상)">
            <Input
              onChange={(e) => (reason = e.target.value)}
              placeholder="감사 로그에 기록됩니다"
            />
          </Form.Item>
        </Form>
      ),
      okText: '예약 취소',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    try {
      await api.post(`/emails/${id}/cancel`, { reason });
      void message.success('예약을 취소했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['emails'] });
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '취소하지 못했습니다.');
    }
  }

  return (
    <>
      <PageHeader
        title={c ? `이메일 #${c.id}` : '이메일'}
        sub={c?.subject}
        extra={
          c?.status === 'SCHEDULED' &&
          can(Permission.EMAIL_SEND) && (
            <Button danger onClick={cancel}>
              예약 취소
            </Button>
          )
        }
      />
      <Card loading={detail.isLoading}>
        {c && (
          <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
            <Descriptions.Item label="상태">
              <CampaignStatusTag status={c.status} />
            </Descriptions.Item>
            <Descriptions.Item label="대상">{c.targetLabel}</Descriptions.Item>
            <Descriptions.Item label="제목">
              {c.isAd && <Tag color="magenta">광고</Tag>}
              {c.subject}
            </Descriptions.Item>
            <Descriptions.Item label="결과">
              <CountsText c={c.counts} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {' '}
                (전체 {fmtNumber(c.counts.total)})
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="발송(예약) 시각">
              {fmtDateTime(c.scheduledAt)}
            </Descriptions.Item>
            <Descriptions.Item label="완료">{fmtDateTime(c.finishedAt)}</Descriptions.Item>
            <Descriptions.Item label="보낸 사람">
              {c.createdBy?.name ?? '-'} ({c.channel === 'MCP' ? 'AI·MCP' : '웹'})
            </Descriptions.Item>
            <Descriptions.Item label="사유">{c.reason}</Descriptions.Item>
            <Descriptions.Item label="본문" span={2}>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {c.body}
                {c.cta && (
                  <div style={{ marginTop: 8 }}>
                    버튼: {c.cta.label} →{' '}
                    <Typography.Text code copyable>
                      {c.cta.url}
                    </Typography.Text>
                  </div>
                )}
              </Typography.Paragraph>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title="수신자별 결과" style={{ marginTop: 16 }}>
        <Segmented
          style={{ marginBottom: 12 }}
          value={status}
          onChange={(v) => {
            setStatus(v as EmailDeliveryStatus | 'ALL');
            setPage(1);
          }}
          options={[
            { value: 'ALL', label: '전체' },
            ...Object.entries(DELIVERY_STATUS).map(([value, s]) => ({ value, label: s.label })),
          ]}
        />
        <Table<EmailDeliveryItem>
          rowKey="id"
          size="small"
          loading={deliveries.isFetching}
          dataSource={deliveries.data?.items ?? []}
          pagination={{
            current: page,
            pageSize: 20,
            total: deliveries.data?.total ?? 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          locale={{
            emptyText:
              c?.status === 'SCHEDULED' ? '예약 시각이 되면 발송됩니다' : '결과가 없습니다',
          }}
          columns={[
            {
              title: '회원',
              key: 'user',
              render: (_, r) =>
                r.publicId ? (
                  `${r.nickname ?? ''} (${r.publicId})`
                ) : (
                  <Typography.Text type="secondary">직접 입력</Typography.Text>
                ),
            },
            { title: '주소', dataIndex: 'address' },
            {
              title: '결과',
              dataIndex: 'status',
              width: 110,
              render: (s: EmailDeliveryStatus) => <DeliveryStatusTag status={s} />,
            },
            {
              title: '메모',
              dataIndex: 'error',
              render: (v: string | null) =>
                v ? <Typography.Text type="secondary">{v}</Typography.Text> : null,
            },
            { title: '처리 시각', dataIndex: 'processedAt', width: 150, render: fmtDateTime },
          ]}
        />
      </Card>
    </>
  );
}
