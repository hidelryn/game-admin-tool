import { Button, Flex, Form, InputNumber, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { ITEM_REWARD_MAX, MAIL_MAX_REWARDS, type RewardType } from '@game-admin/shared';
import { fmtNumber } from '../../shared/format';
import { useCurrencies } from '../currencies/common';
import { useItems } from './common';

export interface RewardInput {
  type: RewardType;
  code?: string;
  quantity?: number;
}

/**
 * 우편 보상 입력 (재화·아이템, 최대 10개)
 * 수량 상한은 서버와 같은 규칙: 재화는 재화별 1회 지급 상한, 아이템은 1,000개
 */
export function RewardsEditor({
  name = 'rewards',
  fullPath,
}: {
  /** Form.List 이름 (다른 Form.List 안에 넣을 땐 [field.name, 'rewards'] 처럼 상대 경로) */
  name?: string | (string | number)[];
  /** 폼 기준 전체 경로 (중첩일 때만 지정, 예: ['tiers', 0, 'rewards']) */
  fullPath?: (string | number)[];
}) {
  const path = fullPath ?? (Array.isArray(name) ? name : [name]);
  const currencies = useCurrencies();
  const items = useItems();
  const form = Form.useFormInstance();
  const rewards: RewardInput[] = Form.useWatch(path, form) ?? [];

  const limitOf = (r?: RewardInput) => {
    if (!r?.code) return undefined;
    if (r.type === 'ITEM') return ITEM_REWARD_MAX;
    return currencies.data?.find((c) => c.code === r.code)?.grantLimitPerRequest;
  };

  return (
    <Form.List
      name={name}
      rules={[
        {
          validator: async (_, list: RewardInput[] = []) => {
            const keys = list.filter((r) => r?.code).map((r) => `${r.type}:${r.code}`);
            if (new Set(keys).size !== keys.length) throw new Error('같은 보상이 중복되었습니다.');
          },
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => (
        <>
          {fields.map((field) => {
            const current = rewards[field.name];
            const limit = limitOf(current);
            const options =
              current?.type === 'ITEM'
                ? (items.data ?? []).map((i) => ({ value: i.code, label: i.name }))
                : (currencies.data ?? []).map((c) => ({
                    value: c.code,
                    label: `${c.name}${c.isPaid ? ' (유료)' : ''}`,
                  }));
            return (
              <Flex key={field.key} gap={8} align="start">
                <Form.Item name={[field.name, 'type']} style={{ width: 100, marginBottom: 8 }}>
                  <Select
                    options={[
                      { value: 'CURRENCY', label: '재화' },
                      { value: 'ITEM', label: '아이템' },
                    ]}
                    onChange={() => form.setFieldValue([...path, field.name, 'code'], undefined)}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'code']}
                  rules={[{ required: true, message: '선택하세요' }]}
                  style={{ flex: 1, minWidth: 140, marginBottom: 8 }}
                >
                  <Select
                    placeholder="보상 선택"
                    options={options}
                    loading={currencies.isLoading || items.isLoading}
                    showSearch
                    optionFilterProp="label"
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'quantity']}
                  rules={[
                    { required: true, message: '수량' },
                    { type: 'number', min: 1, message: '1 이상' },
                    {
                      type: 'number',
                      max: limit ?? Number.MAX_SAFE_INTEGER,
                      message: `최대 ${fmtNumber(limit ?? 0)}`,
                    },
                  ]}
                  style={{ width: 150, marginBottom: 8 }}
                >
                  <InputNumber<number>
                    min={1}
                    max={limit}
                    placeholder={limit ? `최대 ${fmtNumber(limit)}` : '수량'}
                    style={{ width: '100%' }}
                    formatter={(v) => (v ? Number(v).toLocaleString('ko-KR') : '')}
                    parser={(v) => Number((v ?? '').replace(/[^\d]/g, ''))}
                  />
                </Form.Item>
                <Button
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => remove(field.name)}
                  aria-label="보상 삭제"
                />
              </Flex>
            );
          })}
          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() => add({ type: 'CURRENCY' })}
            disabled={fields.length >= MAIL_MAX_REWARDS}
            block
          >
            보상 추가 ({fields.length}/{MAIL_MAX_REWARDS})
          </Button>
          <Form.ErrorList errors={errors} />
          {fields.length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              보상 없이 안내만 보낼 수도 있습니다.
            </Typography.Text>
          )}
        </>
      )}
    </Form.List>
  );
}
