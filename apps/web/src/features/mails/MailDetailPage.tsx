import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Modal,
  Result,
  Row,
  Skeleton,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import dayjs from 'dayjs';
import { Permission, type MailDetail, type MailRecipientView } from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { ReasonField } from '../../shared/components/ReasonField';
import { fmtDateTime, fmtNumber } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { MAIL_TYPE_LABEL, MailStatusTag, RewardTags } from './common';

export function MailDetailPage() {
  const { mailId = '' } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [cancelOpen, setCancelOpen] = useState(false);

  const detail = useQuery({
    queryKey: ['mail', mailId],
    queryFn: async () => (await api.get<MailDetail>(`/mails/${mailId}`)).data,
  });
  const recipients = useQuery({
    queryKey: ['mail', mailId, 'recipients', page],
    queryFn: () => api.get<MailRecipientView[]>(`/mails/${mailId}/recipients`, { page, size: 20 }),
    placeholderData: keepPreviousData,
  });

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return <Result status="404" title="우편을 찾을 수 없습니다" subTitle={`#${mailId}`} />;
  }
  const m = detail.data;
  const isGlobal = m?.type === 'GLOBAL';
  const expired = m ? dayjs(m.expiresAt).isBefore(dayjs()) : false;
  // 전체 우편 취소는 mail:send_all 권한 (서버와 같은 규칙)
  const canCancel =
    m &&
    m.status === 'SENT' &&
    !expired &&
    can(isGlobal ? Permission.MAIL_SEND_ALL : Permission.MAIL_SEND);

  return (
    <>
      <PageHeader
        title={m ? m.title : `우편 #${mailId}`}
        sub={m && `#${m.id} · ${MAIL_TYPE_LABEL[m.type]} 우편`}
        extra={
          canCancel && (
            <Button danger icon={<StopOutlined />} onClick={() => setCancelOpen(true)}>
              발송 취소
            </Button>
          )
        }
      />

      {m?.status === 'CANCELED' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${fmtDateTime(m.canceledAt)} 에 취소된 우편입니다`}
          description="취소 전에 받은 보상은 그대로 유지됩니다."
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card title="우편 정보">
            <Skeleton loading={detail.isLoading} active>
              {m && (
                <Descriptions
                  bordered
                  size="small"
                  column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2, xxl: 2 }}
                  styles={{ label: { width: 96, whiteSpace: 'nowrap' } }}
                >
                  <Descriptions.Item label="상태">
                    <MailStatusTag status={m.status} expiresAt={m.expiresAt} />
                  </Descriptions.Item>
                  <Descriptions.Item label="유형">{MAIL_TYPE_LABEL[m.type]}</Descriptions.Item>
                  <Descriptions.Item label="발송">{fmtDateTime(m.sentAt)}</Descriptions.Item>
                  <Descriptions.Item label="만료">{fmtDateTime(m.expiresAt)}</Descriptions.Item>
                  <Descriptions.Item label="본문" span={2}>
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                      {m.body}
                    </Typography.Paragraph>
                  </Descriptions.Item>
                  <Descriptions.Item label="보상" span={2}>
                    <RewardTags rewards={m.rewards} />
                  </Descriptions.Item>
                  {isGlobal && (
                    <Descriptions.Item label="대상 조건" span={2}>
                      {typeof m.targetFilter?.registeredBefore === 'string'
                        ? `${fmtDateTime(m.targetFilter.registeredBefore)} 이전 가입 회원`
                        : '전체 회원'}
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="발송자">{m.createdBy.name}</Descriptions.Item>
                  <Descriptions.Item label="사유">{m.reason}</Descriptions.Item>
                </Descriptions>
              )}
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="수령 현황">
            <Skeleton loading={detail.isLoading} active paragraph={{ rows: 1 }}>
              {m && (
                <Row gutter={16}>
                  <Col span={12}>
                    <Statistic title="수령" value={m.claimedCount} suffix="명" />
                  </Col>
                  <Col span={12}>
                    {isGlobal ? (
                      <Statistic title="대상" value="전체" />
                    ) : (
                      <Statistic
                        title="수령률"
                        value={m.recipientCount ? (m.claimedCount / m.recipientCount) * 100 : 0}
                        precision={1}
                        suffix={`% / ${fmtNumber(m.recipientCount ?? 0)}명`}
                      />
                    )}
                  </Col>
                </Row>
              )}
            </Skeleton>
          </Card>
        </Col>
      </Row>

      <Card title={isGlobal ? '수령한 회원' : '받는 회원'} style={{ marginTop: 16 }}>
        <Table<MailRecipientView>
          rowKey="publicId"
          size="small"
          loading={recipients.isFetching}
          dataSource={recipients.data?.data ?? []}
          locale={{
            emptyText: (
              <Empty description={isGlobal ? '아직 수령한 회원이 없습니다' : '대상이 없습니다'} />
            ),
          }}
          pagination={{
            current: page,
            pageSize: 20,
            total: Number(recipients.data?.meta?.total ?? 0),
            showSizeChanger: false,
            onChange: setPage,
          }}
          columns={[
            {
              title: '회원 ID',
              dataIndex: 'publicId',
              width: 140,
              render: (v: string) => <Link to={`/users/${v}`}>{v}</Link>,
            },
            { title: '닉네임', dataIndex: 'nickname' },
            ...(isGlobal
              ? []
              : [{ title: '읽음', dataIndex: 'readAt', width: 160, render: fmtDateTime }]),
            {
              title: '수령',
              dataIndex: 'claimedAt',
              width: 160,
              render: (v: string | null) => (v ? fmtDateTime(v) : <Tag>미수령</Tag>),
            },
          ]}
        />
      </Card>

      {m && (
        <CancelMailModal
          mail={m}
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['mail', mailId] });
            void queryClient.invalidateQueries({ queryKey: ['mails'] });
          }}
        />
      )}
    </>
  );
}

/** 발송 취소 (L2): 사유 입력 → 서버가 수령 현황 미리보기와 확인을 요구 → 실행 */
function CancelMailModal({
  mail,
  open,
  onClose,
  onDone,
}: {
  mail: MailDetail;
  open: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  const [loading, setLoading] = useState(false);
  const run = useSafeAction();

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    const res = await run({
      request: ({ confirmationToken }) =>
        api.post(`/mails/${mail.id}/cancel`, { reason: v.reason, confirmationToken }),
      confirmTitle: '우편 발송 취소',
      renderPreview: (p) => {
        const preview = p as { title: string; recipientCount: number | null; claimedCount: number };
        return (
          <Descriptions column={1} size="small" bordered style={{ marginBottom: 8 }}>
            <Descriptions.Item label="우편">{preview.title}</Descriptions.Item>
            <Descriptions.Item label="대상">
              {preview.recipientCount === null
                ? '전체 회원'
                : `${fmtNumber(preview.recipientCount)}명`}
            </Descriptions.Item>
            <Descriptions.Item label="이미 수령">
              {fmtNumber(preview.claimedCount)}명 (보상 유지)
            </Descriptions.Item>
            <Descriptions.Item label="사유">{v.reason}</Descriptions.Item>
          </Descriptions>
        );
      },
      successMessage: '발송을 취소했습니다.',
    });
    setLoading(false);
    if (res) {
      onClose();
      onDone();
    }
  }

  return (
    <Modal
      title="발송 취소"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="다음"
      okButtonProps={{ danger: true, loading }}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="아직 받지 않은 회원은 더 이상 받을 수 없게 됩니다"
        description="이미 받은 보상은 회수되지 않습니다. 회수가 필요하면 재화 관리에서 따로 처리하세요."
      />
      <Form form={form} layout="vertical" preserve={false}>
        <ReasonField />
      </Form>
    </Modal>
  );
}
