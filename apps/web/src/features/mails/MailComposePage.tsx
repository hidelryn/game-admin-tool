import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Segmented,
  Select,
  Space,
  Typography,
  Upload,
} from 'antd';
import { MailOutlined, UploadOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router';
import type { Dayjs } from 'dayjs';
import { MAIL_MAX_RECIPIENTS, Permission, type MailSent } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { PageHeader } from '../../shared/components/PageHeader';
import { ReasonField } from '../../shared/components/ReasonField';
import { readTableFile } from '../../shared/file/table-file';
import { fmtNumber } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { currencyLabel, useCurrencies } from '../currencies/common';
import { mergeIds, parseRecipientCells, useItems } from './common';
import { RewardsEditor, type RewardInput } from './RewardsEditor';

type Target = 'users' | 'all';

interface Values {
  recipients: string[];
  title: string;
  body: string;
  rewards: RewardInput[];
  expiresInDays: number;
  registeredBefore?: Dayjs;
  reason: string;
}

/**
 * 우편 발송
 * - 개별: 회원 ID 직접 입력 + 파일(CSV·엑셀)로 추가, 최대 1,000명, 바로 발송
 * - 전체: 모든 회원(가입일 조건 선택) — 빨간 경고로 한 번 더 확인 후 발송 (L3, 웹 전용)
 * 회원 상세의 "우편 보내기"로 오면 ?to=회원ID 로 대상이 채워진다
 */
export function MailComposePage() {
  const [form] = Form.useForm<Values>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { modal, message } = App.useApp();
  const { can } = useAuth();
  const run = useSafeAction();
  const currencies = useCurrencies();
  const items = useItems();
  const [target, setTarget] = useState<Target>('users');
  const [loading, setLoading] = useState(false);

  const canSendAll = can(Permission.MAIL_SEND_ALL);
  const recipients: string[] = Form.useWatch('recipients', form) ?? [];
  const title = Form.useWatch('title', form);
  const body = Form.useWatch('body', form);
  const rewards: RewardInput[] = Form.useWatch('rewards', form) ?? [];
  const expiresInDays = Form.useWatch('expiresInDays', form);

  const rewardName = (r: RewardInput) =>
    r.type === 'ITEM'
      ? (items.data?.find((i) => i.code === r.code)?.name ?? r.code)
      : currencyLabel(currencies.data, r.code ?? '');

  /** 파일의 회원 ID 를 입력칸에 합친다 */
  async function addFromFile(file: File) {
    try {
      const fromFile = parseRecipientCells(await readTableFile(file));
      const merged = mergeIds(
        recipients,
        fromFile.ids.map((value, i) => ({ row: i, value })),
      );
      form.setFieldValue('recipients', merged.ids);
      void form.validateFields(['recipients']);
      const added = merged.ids.length - recipients.length;
      const notes = [
        fromFile.invalid.length
          ? `형식 오류 ${fromFile.invalid.length}건 제외 (${fromFile.invalid
              .slice(0, 3)
              .map((x) => `${x.row}행`)
              .join(', ')}…)`
          : '',
        fromFile.duplicates + merged.duplicates
          ? `중복 ${fromFile.duplicates + merged.duplicates}건 제외`
          : '',
      ].filter(Boolean);
      void message.info(
        `${file.name}: ${fmtNumber(added)}명 추가${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
      );
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '파일을 읽지 못했습니다.');
    }
  }

  async function submit() {
    const v = await form.validateFields();
    const content = {
      title: v.title,
      body: v.body,
      rewards: (v.rewards ?? []).map((r) => ({
        type: r.type,
        code: r.code!,
        quantity: r.quantity!,
      })),
      expiresInDays: v.expiresInDays,
      reason: v.reason,
    };

    const ok = await modal.confirm({
      title: target === 'all' ? '전체 우편 발송' : '우편 발송',
      width: 480,
      content: (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="대상">
            {target === 'all'
              ? v.registeredBefore
                ? `${v.registeredBefore.format('YYYY-MM-DD HH:mm')} 이전 가입 회원 전체`
                : '전체 회원'
              : `${fmtNumber(v.recipients.length)}명`}
          </Descriptions.Item>
          <Descriptions.Item label="제목">{v.title}</Descriptions.Item>
          <Descriptions.Item label="보상">
            {content.rewards.length
              ? content.rewards.map((r) => (
                  <div
                    key={`${r.type}:${r.code}`}
                  >{`${rewardName(r)} ×${fmtNumber(r.quantity)}`}</div>
                ))
              : '없음'}
          </Descriptions.Item>
          <Descriptions.Item label="유효기간">{v.expiresInDays}일</Descriptions.Item>
          <Descriptions.Item label="처리">
            {target === 'all' ? '다음 단계에서 한 번 더 확인 후 발송' : '즉시 발송'}
          </Descriptions.Item>
        </Descriptions>
      ),
      okText: target === 'all' ? '다음' : '발송',
    });
    if (!ok) return;

    setLoading(true);
    const res =
      target === 'all'
        ? await run<{ mailId: number }>({
            request: ({ idempotencyKey, confirmationToken }) =>
              api.post(
                '/mails/global',
                {
                  ...content,
                  ...(v.registeredBefore
                    ? { targetFilter: { registeredBefore: v.registeredBefore.toISOString() } }
                    : {}),
                  ...(confirmationToken ? { confirmationToken } : {}),
                },
                { idempotencyKey },
              ),
            confirmTitle: '전체 우편 최종 확인',
          })
        : await run<MailSent>({
            request: ({ idempotencyKey }) =>
              api.post('/mails', { ...content, publicIds: v.recipients }, { idempotencyKey }),
            onError: (err) => {
              const d = err.details as { missing?: string[]; withdrawn?: string[] } | undefined;
              const list = d?.missing ?? d?.withdrawn;
              if (!list?.length) return false;
              modal.error({
                title: err.message,
                content: (
                  <>
                    <Typography.Paragraph>
                      아무에게도 발송되지 않았습니다. 아래 회원을 대상에서 빼고 다시 시도하세요.
                    </Typography.Paragraph>
                    <Typography.Paragraph code copyable style={{ whiteSpace: 'pre-wrap' }}>
                      {list.join('\n')}
                    </Typography.Paragraph>
                  </>
                ),
              });
              return true;
            },
          });
    setLoading(false);
    if (!res) return;

    if (target === 'all') {
      void message.success('전체 우편을 발송했습니다.');
      navigate(`/mails/${res.data.mailId}`);
    } else {
      const sent = res.data as MailSent;
      void message.success(`${fmtNumber(sent.recipientCount)}명에게 발송했습니다.`);
      navigate(`/mails/${sent.mailId}`);
    }
  }

  return (
    <>
      <PageHeader
        title="우편 발송"
        sub="개별 발송은 바로, 전체 발송은 한 번 더 확인한 뒤 발송됩니다"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card>
            <Form<Values>
              form={form}
              layout="vertical"
              initialValues={{
                recipients: params.get('to') ? [params.get('to')!] : [],
                rewards: [],
                expiresInDays: 7,
              }}
            >
              <Form.Item label="대상">
                <Segmented<Target>
                  value={target}
                  onChange={setTarget}
                  options={[
                    { value: 'users', label: '개별 회원' },
                    { value: 'all', label: '전체 회원', disabled: !canSendAll },
                  ]}
                />
                {!canSendAll && (
                  <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                    전체 발송은 mail:send_all 권한이 필요합니다
                  </Typography.Text>
                )}
              </Form.Item>

              {target === 'users' ? (
                <Form.Item
                  label={
                    <Flex gap={8} align="center">
                      회원 ID
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {fmtNumber(recipients.length)} / {fmtNumber(MAIL_MAX_RECIPIENTS)}명
                      </Typography.Text>
                    </Flex>
                  }
                  required
                  extra="입력 후 Enter, 또는 쉼표·공백으로 여러 명을 한 번에 입력할 수 있어요. 많을 땐 파일로 추가하세요."
                >
                  <Flex gap={8} align="start">
                    <Form.Item
                      name="recipients"
                      noStyle
                      rules={[
                        {
                          required: true,
                          type: 'array',
                          min: 1,
                          message: '회원을 한 명 이상 입력하세요.',
                        },
                        {
                          type: 'array',
                          max: MAIL_MAX_RECIPIENTS,
                          message: `한 번에 ${fmtNumber(MAIL_MAX_RECIPIENTS)}명까지 보낼 수 있습니다.`,
                        },
                        {
                          validator: async (_, ids: string[] = []) => {
                            const bad = ids.filter((id) => !/^[A-Za-z0-9_-]{1,20}$/.test(id));
                            if (bad.length)
                              throw new Error(`형식이 잘못된 ID: ${bad.slice(0, 5).join(', ')}`);
                          },
                        },
                      ]}
                    >
                      <Select
                        mode="tags"
                        open={false}
                        suffixIcon={null}
                        tokenSeparators={[',', ' ', '\n', '\t']}
                        placeholder="예: U1000001"
                        maxTagCount={30}
                        maxTagPlaceholder={(omitted) => `+${fmtNumber(omitted.length)}명`}
                        style={{ flex: 1 }}
                        allowClear
                      />
                    </Form.Item>
                    <Upload
                      accept=".csv,.xlsx"
                      showUploadList={false}
                      beforeUpload={(file) => {
                        void addFromFile(file);
                        return false; // 파일은 서버로 보내지 않는다
                      }}
                    >
                      <Button icon={<UploadOutlined />}>파일로 추가</Button>
                    </Upload>
                  </Flex>
                </Form.Item>
              ) : (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="전체 우편은 모든 회원에게 바로 들어갑니다"
                    description="발송 전에 대상 인원·보상을 빨간 경고 화면으로 한 번 더 확인합니다. MCP(API 토큰)로는 보낼 수 없습니다. 대상 회원은 게임에 접속해 우편함을 열 때 받습니다."
                  />
                  <Form.Item
                    name="registeredBefore"
                    label="가입일 조건 (선택)"
                    extra="지정하면 이 시각 이전에 가입한 회원만 받을 수 있습니다. 비우면 모든 회원."
                  >
                    <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
                  </Form.Item>
                </>
              )}

              <Divider style={{ margin: '8px 0 16px' }} />
              <Form.Item
                name="title"
                label="제목"
                rules={[
                  { required: true, whitespace: true, message: '제목을 입력하세요.' },
                  { max: 50 },
                ]}
              >
                <Input showCount maxLength={50} placeholder="예: 서버 점검 보상" />
              </Form.Item>
              <Form.Item
                name="body"
                label="본문"
                rules={[
                  { required: true, whitespace: true, message: '본문을 입력하세요.' },
                  { max: 500 },
                ]}
              >
                <Input.TextArea
                  rows={5}
                  showCount
                  maxLength={500}
                  placeholder="회원에게 보이는 내용입니다."
                />
              </Form.Item>
              <Form.Item label="보상">
                <RewardsEditor />
              </Form.Item>
              <Form.Item
                name="expiresInDays"
                label="유효기간"
                rules={[{ required: true, type: 'number', min: 1, max: 30 }]}
              >
                <InputNumber<number> min={1} max={30} addonAfter="일" style={{ width: 140 }} />
              </Form.Item>
              <ReasonField />
              <Space>
                <Button type="primary" icon={<MailOutlined />} loading={loading} onClick={submit}>
                  발송
                </Button>
                <Button onClick={() => navigate(-1)}>취소</Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card title="회원에게 보이는 모습" size="small">
            <div style={{ background: '#f6f7f9', borderRadius: 8, padding: 16 }}>
              <Flex justify="space-between" align="baseline">
                <Typography.Text strong>{title || '제목'}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {expiresInDays ?? 7}일 남음
                </Typography.Text>
              </Flex>
              <Typography.Paragraph
                style={{ whiteSpace: 'pre-wrap', margin: '8px 0 12px', minHeight: 44 }}
                type={body ? undefined : 'secondary'}
              >
                {body || '본문'}
              </Typography.Paragraph>
              <Flex wrap gap={8}>
                {rewards
                  .filter((r) => r?.code)
                  .map((r) => (
                    <div
                      key={`${r.type}:${r.code}`}
                      style={{
                        background: '#fff',
                        border: '1px solid #e5e5e5',
                        borderRadius: 6,
                        padding: '6px 10px',
                        fontSize: 12,
                        textAlign: 'center',
                        minWidth: 72,
                      }}
                    >
                      <div>{rewardName(r)}</div>
                      <b>×{fmtNumber(r.quantity ?? 0)}</b>
                    </div>
                  ))}
              </Flex>
            </div>
            <Typography.Paragraph
              type="secondary"
              style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
            >
              사유는 회원에게 보이지 않고 운영 로그에만 남습니다.
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </>
  );
}
