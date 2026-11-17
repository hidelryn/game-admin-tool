import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  DatePicker,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { EyeInvisibleOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { Permission, type NoticeCategory, type NoticeView } from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ReasonField } from '../../shared/components/ReasonField';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { CATEGORY_LABEL, NoticeStatusTag, fmt } from './common';

interface Values {
  category: NoticeCategory;
  title: string;
  body: string;
  startsAt: Dayjs;
  endsAt?: Dayjs | null;
  openEnded: boolean;
  pinned: boolean;
  tickerEnabled: boolean;
  tickerText?: string;
  reason: string;
}

/**
 * 공지 편집 서랍 — 등록·수정·내리기 모두 L1, 게임에 바로 반영
 * 본문은 평문만 (게임이 글자 그대로 보여줌)
 */
export function NoticeEditor({
  open,
  notice,
  onClose,
}: {
  open: boolean;
  notice?: NoticeView;
  onClose(): void;
}) {
  const [form] = Form.useForm<Values>();
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const run = useSafeAction();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const isNew = !notice;
  const readOnly = !can(Permission.NOTICE_MANAGE) || notice?.status === 'HIDDEN';
  const openEnded = Form.useWatch('openEnded', form);
  const tickerEnabled = Form.useWatch('tickerEnabled', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (notice) {
      form.setFieldsValue({
        category: notice.category,
        title: notice.title,
        body: notice.body,
        startsAt: dayjs(notice.startsAt),
        endsAt: notice.endsAt ? dayjs(notice.endsAt) : null,
        openEnded: !notice.endsAt,
        pinned: notice.pinned,
        tickerEnabled: notice.tickerEnabled,
        tickerText: notice.tickerText ?? undefined,
      });
    } else {
      form.setFieldsValue({
        category: 'NOTICE',
        startsAt: dayjs().second(0),
        endsAt: dayjs().add(7, 'day').hour(23).minute(59).second(0),
        openEnded: false,
        pinned: false,
        tickerEnabled: false,
      });
    }
  }, [open, notice, form]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['notices'] });
  const onConflict = (err: { code: string; message: string }) => {
    if (err.code !== 'VERSION_CONFLICT') return false;
    void message.error(err.message);
    refresh();
    onClose();
    return true;
  };

  async function save() {
    const v = await form.validateFields();
    const body = {
      category: v.category,
      title: v.title,
      body: v.body,
      startsAt: v.startsAt.toISOString(),
      endsAt: v.openEnded || !v.endsAt ? null : v.endsAt.toISOString(),
      pinned: v.pinned,
      tickerEnabled: v.tickerEnabled,
      tickerText: v.tickerText?.trim() ? v.tickerText.trim() : null,
      reason: v.reason,
    };
    setSaving(true);
    const res = isNew
      ? await run<NoticeView>({
          request: ({ idempotencyKey }) => api.post('/notices', body, { idempotencyKey }),
          successMessage: '공지를 등록했습니다.',
        })
      : await run<NoticeView>({
          request: () => api.put(`/notices/${notice.id}`, { ...body, version: notice.version }),
          successMessage: '저장했습니다.',
          onError: onConflict,
        });
    setSaving(false);
    if (res) {
      refresh();
      onClose();
    }
  }

  function hide() {
    if (!notice) return;
    let reason = '';
    void modal.confirm({
      title: '공지 내리기',
      content: (
        <>
          <Typography.Paragraph>
            게임 공지 목록과 한 줄 공지에서 바로 사라집니다.
          </Typography.Paragraph>
          <Input.TextArea
            rows={2}
            placeholder="사유 (5자 이상, 운영 로그에 기록)"
            onChange={(e) => (reason = e.target.value)}
          />
        </>
      ),
      okText: '내리기',
      okButtonProps: { danger: true },
      cancelText: '닫기',
      onOk: async () => {
        if (reason.trim().length < 5) {
          void message.error('사유를 5자 이상 입력하세요.');
          throw new Error('reason');
        }
        const res = await run({
          request: () =>
            api.post(`/notices/${notice.id}/hide`, {
              reason: reason.trim(),
              version: notice.version,
            }),
          successMessage: '공지를 내렸습니다.',
          onError: onConflict,
        });
        if (res) {
          refresh();
          onClose();
        }
      },
    });
  }

  return (
    <Drawer
      open={open}
      width={600}
      onClose={onClose}
      title={
        isNew ? (
          '공지 등록'
        ) : (
          <Space>
            {notice.title} <NoticeStatusTag status={notice.status} />
          </Space>
        )
      }
      extra={
        !readOnly && (
          <Button type="primary" loading={saving} onClick={save}>
            저장
          </Button>
        )
      }
      footer={
        !isNew &&
        !readOnly && (
          <Button danger icon={<EyeInvisibleOutlined />} onClick={hide}>
            내리기
          </Button>
        )
      }
      destroyOnHidden
    >
      {notice?.maintenanceId && !readOnly && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`점검 #${notice.maintenanceId} 과 연결된 공지입니다`}
          description="점검 시간을 바꾸면 이 공지의 제목·본문·한 줄 공지·게시 종료가 점검에 맞춰 다시 쓰입니다."
        />
      )}
      {notice?.status === 'HIDDEN' && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="내린 공지입니다." />
      )}

      <Form<Values> form={form} layout="vertical" disabled={readOnly} requiredMark="optional">
        <Space size={16} wrap>
          <Form.Item name="category" label="분류">
            <Select
              style={{ width: 140 }}
              options={(Object.keys(CATEGORY_LABEL) as NoticeCategory[]).map((k) => ({
                value: k,
                label: CATEGORY_LABEL[k],
              }))}
            />
          </Form.Item>
          <Form.Item name="pinned" label="목록 상단 고정" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Space>
        <Form.Item
          name="title"
          label="제목"
          rules={[{ required: true, whitespace: true }, { max: 60 }]}
        >
          <Input showCount maxLength={60} />
        </Form.Item>
        <Form.Item
          name="body"
          label="본문"
          extra="평문만 — HTML 태그는 글자 그대로 보입니다. 줄바꿈은 유지됩니다."
          rules={[{ required: true, whitespace: true }, { max: 5000 }]}
        >
          <Input.TextArea rows={10} showCount maxLength={5000} />
        </Form.Item>
        <Space size={16} wrap align="start">
          <Form.Item name="startsAt" label="게시 시작" rules={[{ required: true }]}>
            <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
          </Form.Item>
          <Form.Item
            name="endsAt"
            label="게시 종료"
            dependencies={['startsAt', 'openEnded']}
            rules={[
              ({ getFieldValue }) => ({
                validator: async (_, v?: Dayjs | null) => {
                  if (getFieldValue('openEnded')) return;
                  if (!v) throw new Error('게시 종료를 정하거나 "계속 게시"를 고르세요.');
                  if (!v.isAfter(getFieldValue('startsAt')))
                    throw new Error('종료는 시작보다 뒤여야 합니다.');
                },
              }),
            ]}
          >
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              disabled={openEnded || readOnly}
            />
          </Form.Item>
          <Form.Item name="openEnded" label=" " valuePropName="checked">
            <Checkbox>계속 게시 (내릴 때까지)</Checkbox>
          </Form.Item>
        </Space>
        <Form.Item
          name="tickerEnabled"
          label="로비 한 줄 공지"
          valuePropName="checked"
          extra="게시 기간 동안 로비 상단에 흐르는 문구 (고정 → 최신 순으로 최대 5개)"
        >
          <Switch />
        </Form.Item>
        {tickerEnabled && (
          <Form.Item
            name="tickerText"
            label="한 줄 공지 문구"
            rules={[
              { required: true, whitespace: true, message: '문구를 입력하세요.' },
              { max: 80 },
            ]}
          >
            <Input showCount maxLength={80} />
          </Form.Item>
        )}
        {!readOnly && <ReasonField />}
      </Form>

      {notice && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          등록 {notice.createdBy.name} · {fmt(notice.createdAt)} / 마지막 수정{' '}
          {notice.updatedBy.name} · {fmt(notice.updatedAt)}
        </Typography.Paragraph>
      )}
    </Drawer>
  );
}
