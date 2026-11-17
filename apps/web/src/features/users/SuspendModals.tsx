import { useState } from 'react';
import { Descriptions, Form, InputNumber, Modal, Radio } from 'antd';
import { api } from '../../shared/api/client';
import { ReasonField } from '../../shared/components/ReasonField';
import { useSafeAction } from '../../shared/safety/useSafeAction';

interface Props {
  publicId: string;
  open: boolean;
  onClose(): void;
  onDone(): void;
}

/** 기간 정지는 바로 실행, 영구 정지는 서버가 확인 토큰을 요구 → 미리보기 후 실행 */
export function SuspendModal({ publicId, open, onClose, onDone }: Props) {
  const [form] = Form.useForm<{
    kind: 'days' | 'permanent';
    durationDays: number;
    reason: string;
  }>();
  const [loading, setLoading] = useState(false);
  const run = useSafeAction();
  const kind = Form.useWatch('kind', form);

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    const body =
      v.kind === 'permanent'
        ? { permanent: true, reason: v.reason }
        : { durationDays: v.durationDays, reason: v.reason };
    const res = await run({
      request: ({ confirmationToken }) =>
        api.post(`/users/${publicId}/suspend`, { ...body, confirmationToken }),
      confirmTitle: '영구 정지 확인',
      renderPreview: (p) => {
        const preview = p as { publicId: string; nickname: string };
        return (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="회원">{`${preview.nickname} (${preview.publicId})`}</Descriptions.Item>
            <Descriptions.Item label="처리">영구 정지</Descriptions.Item>
            <Descriptions.Item label="사유">{v.reason}</Descriptions.Item>
          </Descriptions>
        );
      },
      successMessage: '회원을 정지했습니다.',
    });
    setLoading(false);
    if (res) {
      form.resetFields();
      onClose();
      onDone();
    }
  }

  return (
    <Modal
      title="회원 정지"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="정지"
      okButtonProps={{ danger: true, loading }}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ kind: 'days', durationDays: 7 }}
        preserve={false}
      >
        <Form.Item name="kind" label="정지 유형">
          <Radio.Group
            options={[
              { value: 'days', label: '기간 정지' },
              { value: 'permanent', label: '영구 정지' },
            ]}
          />
        </Form.Item>
        {kind !== 'permanent' && (
          <Form.Item
            name="durationDays"
            label="기간(일)"
            rules={[{ required: true, type: 'number', min: 1, max: 3650 }]}
          >
            <InputNumber min={1} max={3650} addonAfter="일" style={{ width: 160 }} />
          </Form.Item>
        )}
        <ReasonField />
      </Form>
    </Modal>
  );
}

export function UnsuspendModal({ publicId, open, onClose, onDone }: Props) {
  const [form] = Form.useForm<{ reason: string }>();
  const [loading, setLoading] = useState(false);
  const run = useSafeAction();

  async function submit() {
    const v = await form.validateFields();
    setLoading(true);
    const res = await run({
      request: () => api.post(`/users/${publicId}/unsuspend`, v),
      successMessage: '정지를 해제했습니다.',
    });
    setLoading(false);
    if (res) {
      onClose();
      onDone();
    }
  }

  return (
    <Modal
      title="정지 해제"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="해제"
      okButtonProps={{ loading }}
      destroyOnClose
    >
      <Form form={form} layout="vertical" preserve={false}>
        <ReasonField />
      </Form>
    </Modal>
  );
}
