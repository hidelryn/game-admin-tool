import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Typography,
} from 'antd';
import { EyeOutlined, SendOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import {
  EMAIL_BODY_MAX,
  EMAIL_MAX_USERS,
  EMAIL_SUBJECT_MAX,
  Permission,
  type EmailLimits,
  type EmailPreview,
  type EmailRendered,
  type EmailSendResult,
  type EmailTarget,
} from '@game-admin/shared';
import { api, ApiError } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { ReasonField } from '../../shared/components/ReasonField';
import { fmtNumber } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';

type TargetKind = 'USERS' | 'ALL' | 'ADDRESS';

interface Values {
  publicIds: string[];
  address: string;
  subject: string;
  body: string;
  isAd: boolean;
  ctaLabel?: string;
  ctaUrl?: string;
  scheduledAt?: Dayjs;
  reason: string;
}

/**
 * 이메일 작성 (docs/email.md)
 * - 회원 지정(99명까지 바로) · 전체(빨간 경고 확인) · 주소 직접 입력(1건, 실제 발송)
 * - "대상 확인"으로 보내기 전에 실제·가상·제외 인원을 미리 본다
 */
export function EmailComposePage() {
  const [form] = Form.useForm<Values>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { can } = useAuth();
  const run = useSafeAction();
  const [kind, setKind] = useState<TargetKind>('USERS');
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [rendered, setRendered] = useState<EmailRendered | null>(null);
  const [rendering, setRendering] = useState(false);

  const limits = useQuery({
    queryKey: ['emails', 'limits'],
    queryFn: async () => (await api.get<EmailLimits>('/emails/limits')).data,
  });
  const demo = limits.data?.demo ?? null;
  const publicIds: string[] = Form.useWatch('publicIds', form) ?? [];
  const isAd = Form.useWatch('isAd', form) ?? false;
  // 체험 계정이 실제로 보내는 메일(주소 직접 입력)에는 버튼(링크)을 넣을 수 없다
  const ctaBlocked = kind === 'ADDRESS' && !!demo;

  function cta(v: Partial<Values>) {
    const label = v.ctaLabel?.trim();
    const url = v.ctaUrl?.trim();
    return !ctaBlocked && label && url ? { cta: { label, url } } : {};
  }

  async function showRendered() {
    let v: Values;
    try {
      v = await form.validateFields(['subject', 'body', 'ctaLabel', 'ctaUrl']);
    } catch {
      return;
    }
    setRendering(true);
    try {
      const res = await api.post<EmailRendered>('/emails/render', {
        targetType: kind,
        subject: v.subject,
        body: v.body,
        isAd: kind === 'ADDRESS' ? false : !!form.getFieldValue('isAd'),
        ...cta(v),
      });
      setRendered(res.data);
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '미리보기를 만들지 못했습니다.');
    } finally {
      setRendering(false);
    }
  }

  function target(v: Partial<Values>): EmailTarget {
    if (kind === 'ALL') return { type: 'ALL' };
    if (kind === 'ADDRESS') return { type: 'ADDRESS', address: (v.address ?? '').trim() };
    return { type: 'USERS', publicIds: v.publicIds ?? [] };
  }

  async function check() {
    const v = form.getFieldsValue();
    if (kind === 'USERS' && !v.publicIds?.length) {
      void message.warning('회원 ID 를 입력하세요.');
      return;
    }
    setChecking(true);
    try {
      const res = await api.post<EmailPreview>('/emails/preview', {
        target: target(v),
        isAd: kind === 'ADDRESS' ? false : !!v.isAd,
        ...(v.scheduledAt ? { scheduledAt: v.scheduledAt.toISOString() } : {}),
      });
      setPreview(res.data);
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '확인하지 못했습니다.');
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    const v = await form.validateFields();
    setSending(true);
    const body = {
      target: target(v),
      subject: v.subject,
      body: v.body,
      isAd: kind === 'ADDRESS' ? false : !!v.isAd,
      ...cta(v),
      ...(kind !== 'ADDRESS' && v.scheduledAt ? { scheduledAt: v.scheduledAt.toISOString() } : {}),
      reason: v.reason,
    };
    const res = await run<EmailSendResult>({
      request: ({ idempotencyKey, confirmationToken }) =>
        api.post('/emails', { ...body, confirmationToken }, { idempotencyKey }),
      confirmTitle: '이메일 대량 발송 확인',
    });
    setSending(false);
    if (!res) return;
    const r = res.data;
    if (kind === 'ADDRESS') {
      if (r.counts.sent)
        void message.success('메일을 보냈습니다. 받은편지함(또는 스팸함)을 확인해 보세요.');
      else if (r.counts.failed)
        void message.error('발송에 실패했습니다. 상세 화면에서 사유를 확인하세요.');
      else void message.info('SMTP 가 설정되지 않아 가상 발송으로 기록했습니다.');
    } else {
      void message.success(
        v.scheduledAt ? '예약했습니다.' : '발송을 시작했습니다. 1분 안에 결과가 채워집니다.',
      );
    }
    navigate(`/emails/${r.campaignId}`);
  }

  const maxBody = kind === 'ADDRESS' && demo ? demo.bodyMax : EMAIL_BODY_MAX;

  return (
    <>
      <PageHeader
        title="새 이메일"
        sub="보내기 전에 '대상 확인'으로 몇 명에게 어떻게 처리되는지 볼 수 있어요"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card>
            {limits.data && !limits.data.smtpConfigured && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="SMTP 가 설정되지 않아 모든 메일이 가상 발송으로 기록됩니다"
              />
            )}
            <Form<Values>
              form={form}
              layout="vertical"
              initialValues={{
                publicIds: params.get('to') ? [params.get('to')!] : [],
                isAd: false,
              }}
              onValuesChange={() => setPreview(null)}
            >
              <Form.Item label="대상">
                <Segmented<TargetKind>
                  value={kind}
                  onChange={(k) => {
                    setKind(k);
                    setPreview(null);
                  }}
                  options={[
                    { value: 'USERS', label: '회원 지정' },
                    { value: 'ALL', label: '전체 회원', disabled: !can(Permission.EMAIL_SEND_ALL) },
                    { value: 'ADDRESS', label: '주소 직접 입력' },
                  ]}
                />
              </Form.Item>

              {kind === 'USERS' && (
                <Form.Item
                  name="publicIds"
                  label={`회원 ID (${fmtNumber(publicIds.length)} / ${fmtNumber(EMAIL_MAX_USERS)}명)`}
                  extra="입력 후 Enter, 또는 쉼표·공백으로 여러 명. 100명 이상은 빨간 경고로 한 번 더 확인합니다."
                  rules={[
                    { required: true, type: 'array', min: 1, message: '회원 ID 를 입력하세요.' },
                    { type: 'array', max: EMAIL_MAX_USERS, message: `최대 ${EMAIL_MAX_USERS}명` },
                  ]}
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[',', ' ', '\n']}
                    open={false}
                    placeholder="U1000001"
                  />
                </Form.Item>
              )}

              {kind === 'ADDRESS' && (
                <>
                  <Form.Item
                    name="address"
                    label="받는 주소"
                    rules={[
                      { required: true, type: 'email', message: '이메일 주소를 입력하세요.' },
                    ]}
                    extra="실제로 발송됩니다. 받은편지함에 없으면 스팸함을 확인하세요."
                  >
                    <Input placeholder="you@example.com" autoComplete="off" />
                  </Form.Item>
                  {demo && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message="체험 계정 발송 제한"
                      description={`같은 주소는 하루 ${demo.perAddressPerDay}번, 한 사람(IP)은 1시간에 ${demo.perIpPerHour}번, 체험 계정 전체 하루 ${demo.perDay}통까지. 본문 ${demo.bodyMax}자 이내, 링크·웹 주소는 넣을 수 없어요. 제목 앞에 [Game Admin 체험]이 붙습니다.`}
                    />
                  )}
                </>
              )}

              <Form.Item
                name="subject"
                label="제목"
                rules={[
                  { required: true, max: EMAIL_SUBJECT_MAX, message: `1~${EMAIL_SUBJECT_MAX}자` },
                ]}
              >
                <Input maxLength={EMAIL_SUBJECT_MAX} showCount />
              </Form.Item>
              <Form.Item
                name="body"
                label="본문 (평문)"
                rules={[{ required: true, max: maxBody, message: `1~${fmtNumber(maxBody)}자` }]}
              >
                <Input.TextArea
                  rows={8}
                  maxLength={maxBody}
                  showCount
                  placeholder="빈 줄로 문단을 나눠요. 보낼 때 게임 알림 디자인 틀에 넣어집니다."
                />
              </Form.Item>

              {ctaBlocked ? (
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                  체험 계정이 실제로 보내는 메일에는 버튼(링크)을 넣을 수 없어요.
                </Typography.Paragraph>
              ) : (
                <Row gutter={12}>
                  <Col xs={24} md={9}>
                    <Form.Item
                      name="ctaLabel"
                      label="버튼 문구 (선택)"
                      dependencies={['ctaUrl']}
                      rules={[
                        { max: 30, message: '30자 이내' },
                        ({ getFieldValue }) => ({
                          validator: (_, v?: string) =>
                            !v?.trim() && getFieldValue('ctaUrl')?.trim()
                              ? Promise.reject(new Error('버튼 문구를 입력하세요.'))
                              : Promise.resolve(),
                        }),
                      ]}
                    >
                      <Input maxLength={30} placeholder="지금 접속하기" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={15}>
                    <Form.Item
                      name="ctaUrl"
                      label="버튼 링크"
                      dependencies={['ctaLabel']}
                      rules={[
                        { pattern: /^https:\/\/\S+$/, message: 'https:// 로 시작하는 링크만' },
                        ({ getFieldValue }) => ({
                          validator: (_, v?: string) =>
                            !v?.trim() && getFieldValue('ctaLabel')?.trim()
                              ? Promise.reject(new Error('버튼 링크를 입력하세요.'))
                              : Promise.resolve(),
                        }),
                      ]}
                    >
                      <Input maxLength={500} placeholder="https://" />
                    </Form.Item>
                  </Col>
                </Row>
              )}

              {kind !== 'ADDRESS' && (
                <Space size={24} wrap align="start">
                  <Form.Item name="isAd" valuePropName="checked">
                    <Checkbox>
                      광고성 메일
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                        제목에 (광고) · 수신 동의 회원만 · 야간(21~08시)은 야간 동의 회원만
                      </Typography.Text>
                    </Checkbox>
                  </Form.Item>
                  <Form.Item name="scheduledAt" label="예약 발송 (비우면 바로)">
                    <DatePicker
                      showTime={{ format: 'HH:mm' }}
                      format="YYYY-MM-DD HH:mm"
                      disabledDate={(d) =>
                        d.isBefore(dayjs().startOf('day')) || d.isAfter(dayjs().add(30, 'day'))
                      }
                    />
                  </Form.Item>
                </Space>
              )}

              <ReasonField />

              <Space>
                <Button onClick={check} loading={checking}>
                  대상 확인
                </Button>
                <Button icon={<EyeOutlined />} onClick={showRendered} loading={rendering}>
                  메일 미리보기
                </Button>
                <Button type="primary" icon={<SendOutlined />} onClick={submit} loading={sending}>
                  {kind === 'ADDRESS' ? '보내기' : isAd ? '광고 메일 보내기' : '보내기'}
                </Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card title="대상 확인">
            {!preview ? (
              <Typography.Text type="secondary">
                '대상 확인'을 누르면 지금 기준으로 계산해요.
              </Typography.Text>
            ) : (
              <>
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="대상">{fmtNumber(preview.total)}명</Descriptions.Item>
                  <Descriptions.Item label="실제 발송">
                    {fmtNumber(preview.real)}통
                  </Descriptions.Item>
                  <Descriptions.Item label="가상 발송">
                    {fmtNumber(preview.virtual)}통
                  </Descriptions.Item>
                  <Descriptions.Item label="수신 거부 제외">
                    {fmtNumber(preview.skippedNoConsent)}명
                  </Descriptions.Item>
                  <Descriptions.Item label="야간 제외">
                    {fmtNumber(preview.skippedNight)}명
                  </Descriptions.Item>
                  <Descriptions.Item label="정지·탈퇴 제외">
                    {fmtNumber(preview.skippedInactive)}명
                  </Descriptions.Item>
                </Descriptions>
                {preview.bulk && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginTop: 12 }}
                    message="대량 발송 — 보내기를 누르면 빨간 경고 화면에서 한 번 더 확인합니다 (웹에서만)"
                  />
                )}
                {preview.notes.map((n) => (
                  <Typography.Paragraph
                    key={n}
                    type="secondary"
                    style={{ fontSize: 12, margin: '8px 0 0' }}
                  >
                    · {n}
                  </Typography.Paragraph>
                ))}
              </>
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={!!rendered}
        onCancel={() => setRendered(null)}
        footer={null}
        width={680}
        title={rendered?.subject}
        destroyOnHidden
      >
        {/* sandbox: 스크립트·폼·링크 이동 모두 막힌 상태로 그리기만 */}
        <iframe
          title="메일 미리보기"
          sandbox=""
          srcDoc={rendered?.html}
          style={{ width: '100%', height: 560, border: 0, borderRadius: 8 }}
        />
      </Modal>
    </>
  );
}
