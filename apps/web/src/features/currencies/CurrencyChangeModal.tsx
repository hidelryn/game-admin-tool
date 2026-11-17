import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Typography,
} from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_AMOUNT_MAX,
  Permission,
  type CurrencyChangePreview,
  type CurrencyChangeResult,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ReasonField } from '../../shared/components/ReasonField';
import { fmtNumber, fmtSigned } from '../../shared/format';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { currencyLabel, useCurrencies } from './common';

type Op = 'grant' | 'deduct';

interface Values {
  publicId: string;
  op: Op;
  currencyCode: string;
  amount: number;
  reason: string;
}

interface Props {
  open: boolean;
  onClose(): void;
  /** 회원 상세에서 열면 고정. 비우면 회원 ID 입력칸이 나온다 */
  publicId?: string;
  defaultOp?: Op;
  onDone?(result: CurrencyChangeResult): void;
}

/**
 * 단건 지급·회수
 * - 회수는 항상, 지급은 1회 상한 초과 시 서버가 확인을 요구 → 잔액 변화 미리보기 후 실행 (L2)
 * - Idempotency-Key 는 useSafeAction 이 1·2차 호출에 같은 값으로 넣는다
 */
export function CurrencyChangeModal({
  open,
  onClose,
  publicId,
  defaultOp = 'grant',
  onDone,
}: Props) {
  const [form] = Form.useForm<Values>();
  const [loading, setLoading] = useState(false);
  const { modal } = App.useApp();
  const { can } = useAuth();
  const run = useSafeAction();
  const queryClient = useQueryClient();
  const currencies = useCurrencies();

  const canGrant = can(Permission.CURRENCY_GRANT);
  const canDeduct = can(Permission.CURRENCY_DEDUCT);
  const op = Form.useWatch('op', form);
  const code = Form.useWatch('currencyCode', form);
  const amount = Form.useWatch('amount', form);
  const selected = currencies.data?.find((c) => c.code === code);
  const overLimit = op === 'grant' && selected && amount > selected.grantLimitPerRequest;

  useEffect(() => {
    if (open) form.setFieldsValue({ op: canGrant ? defaultOp : 'deduct' });
  }, [open, defaultOp, canGrant, form]);

  async function submit() {
    const v = await form.validateFields();
    const target = (publicId ?? v.publicId).trim();
    setLoading(true);
    const res = await run<CurrencyChangeResult>({
      request: ({ idempotencyKey, confirmationToken }) =>
        api.post(
          `/users/${encodeURIComponent(target)}/currencies/${v.op}`,
          { currencyCode: v.currencyCode, amount: v.amount, reason: v.reason, confirmationToken },
          { idempotencyKey },
        ),
      confirmTitle: v.op === 'deduct' ? '재화 회수 확인' : '재화 지급 확인',
      renderPreview: (p) => {
        const preview = p as CurrencyChangePreview;
        return (
          <Descriptions column={1} size="small" bordered style={{ marginBottom: 8 }}>
            <Descriptions.Item label="회원">{preview.publicId}</Descriptions.Item>
            <Descriptions.Item label="재화">
              {currencyLabel(currencies.data, preview.currencyCode)}
            </Descriptions.Item>
            <Descriptions.Item label="변경">
              <Typography.Text type={preview.delta < 0 ? 'danger' : 'success'} strong>
                {fmtSigned(preview.delta)}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="잔액">
              {fmtNumber(preview.balanceBefore)} → <b>{fmtNumber(preview.balanceAfter)}</b>
            </Descriptions.Item>
            <Descriptions.Item label="사유">{v.reason}</Descriptions.Item>
          </Descriptions>
        );
      },
    });
    setLoading(false);
    if (!res) return;

    const r = res.data;
    void queryClient.invalidateQueries({ queryKey: ['user', r.publicId] });
    void queryClient.invalidateQueries({ queryKey: ['currency-transactions'] });
    modal.success({
      title: v.op === 'deduct' ? '회수했습니다' : '지급했습니다',
      content: `${currencyLabel(currencies.data, r.currencyCode)} ${fmtSigned(r.delta)} · 잔액 ${fmtNumber(r.balanceBefore)} → ${fmtNumber(r.balanceAfter)}`,
    });
    form.resetFields();
    onClose();
    onDone?.(r);
  }

  return (
    <Modal
      title="재화 지급·회수"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText={op === 'deduct' ? '회수' : '지급'}
      okButtonProps={{ danger: op === 'deduct', loading }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" preserve={false}>
        {publicId ? (
          <Form.Item label="회원">
            <Typography.Text code>{publicId}</Typography.Text>
          </Form.Item>
        ) : (
          <Form.Item
            name="publicId"
            label="회원 ID"
            rules={[{ required: true, message: '회원 ID를 입력하세요.' }]}
          >
            <Input placeholder="예: U00000123" autoComplete="off" />
          </Form.Item>
        )}
        <Form.Item name="op" label="처리">
          <Radio.Group
            optionType="button"
            options={[
              { value: 'grant', label: '지급', disabled: !canGrant },
              { value: 'deduct', label: '회수', disabled: !canDeduct },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="currencyCode"
          label="재화"
          rules={[{ required: true, message: '재화를 선택하세요.' }]}
        >
          <Select
            loading={currencies.isLoading}
            placeholder="재화 선택"
            options={currencies.data?.map((c) => ({
              value: c.code,
              label: `${c.name} (${c.code})${c.isPaid ? ' · 유료' : ''}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="amount"
          label="수량"
          extra={
            selected && op === 'grant'
              ? `1회 지급 상한 ${fmtNumber(selected.grantLimitPerRequest)} — 넘으면 실행 전 한 번 더 확인합니다.`
              : undefined
          }
          rules={[
            {
              required: true,
              type: 'number',
              min: 1,
              max: CURRENCY_AMOUNT_MAX,
              message: `1 ~ ${fmtNumber(CURRENCY_AMOUNT_MAX)}`,
            },
          ]}
        >
          <InputNumber<number>
            min={1}
            max={CURRENCY_AMOUNT_MAX}
            style={{ width: 220 }}
            formatter={(v) => (v ? Number(v).toLocaleString('ko-KR') : '')}
            parser={(v) => Number((v ?? '').replace(/[^\d]/g, ''))}
          />
        </Form.Item>
        {op === 'deduct' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="회수는 실행 전 잔액 변화를 확인한 뒤 진행됩니다."
          />
        )}
        {overLimit && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="1회 지급 상한을 넘었습니다. 실행 전 확인 단계를 거칩니다."
          />
        )}
        <ReasonField />
      </Form>
    </Modal>
  );
}
