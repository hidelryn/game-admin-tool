import { useState } from 'react';
import { Button, Card, Segmented, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Permission,
  type EmailCampaignStatus,
  type EmailCampaignSummary,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { fmtDateTime } from '../../shared/format';
import { CAMPAIGN_STATUS, CampaignStatusTag, CountsText } from './common';

/** 이메일 발송 기록 (docs/email.md) */
export function EmailsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState<EmailCampaignStatus | 'ALL'>('ALL');
  const [page, setPage] = useState(1);
  const size = 20;
  const { data, isFetching } = useQuery({
    queryKey: ['emails', status, page],
    queryFn: async () => {
      const res = await api.get<EmailCampaignSummary[]>('/emails', {
        page,
        size,
        ...(status === 'ALL' ? {} : { status }),
      });
      return { items: res.data, total: (res.meta?.total as number | undefined) ?? 0 };
    },
    placeholderData: keepPreviousData,
    // 발송 중인 게 있으면 자주 새로고침
    refetchInterval: (q) =>
      q.state.data?.items.some((c) => c.status === 'SENDING' || c.status === 'SCHEDULED')
        ? 5_000
        : false,
  });

  return (
    <>
      <PageHeader
        title="이메일"
        sub="회원 지정·전체 발송은 기록 중심(가상 주소는 가상 발송), 주소 직접 입력 1건은 실제로 보냅니다"
        extra={
          can(Permission.EMAIL_SEND) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/emails/new')}>
              새 이메일
            </Button>
          )
        }
      />
      <Card>
        <Segmented
          style={{ marginBottom: 12 }}
          value={status}
          onChange={(v) => {
            setStatus(v as EmailCampaignStatus | 'ALL');
            setPage(1);
          }}
          options={[
            { value: 'ALL', label: '전체' },
            ...Object.entries(CAMPAIGN_STATUS).map(([value, s]) => ({ value, label: s.label })),
          ]}
        />
        <Table<EmailCampaignSummary>
          rowKey="id"
          size="small"
          loading={isFetching}
          dataSource={data?.items ?? []}
          scroll={{ x: 960 }}
          onRow={(r) => ({
            onClick: () => navigate(`/emails/${r.id}`),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: page,
            pageSize: size,
            total: data?.total ?? 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={[
            { title: '#', dataIndex: 'id', width: 64 },
            {
              title: '제목',
              dataIndex: 'subject',
              render: (v: string, r) => (
                <>
                  {r.isAd && <Tag color="magenta">광고</Tag>}
                  {v}
                </>
              ),
            },
            { title: '대상', dataIndex: 'targetLabel', width: 170 },
            {
              title: '상태',
              dataIndex: 'status',
              width: 90,
              render: (s: EmailCampaignStatus) => <CampaignStatusTag status={s} />,
            },
            {
              title: '결과',
              key: 'counts',
              width: 230,
              render: (_, r) => <CountsText c={r.counts} />,
            },
            {
              title: '발송(예약) 시각',
              dataIndex: 'scheduledAt',
              width: 150,
              render: fmtDateTime,
            },
            {
              title: '보낸 사람',
              key: 'by',
              width: 130,
              render: (_, r) => (
                <>
                  {r.createdBy?.name ?? '-'}
                  {r.channel === 'MCP' && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {' '}
                      (AI)
                    </Typography.Text>
                  )}
                </>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
