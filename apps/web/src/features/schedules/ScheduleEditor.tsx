import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Image,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
  Upload,
} from 'antd';
import { DeleteOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  Permission,
  SCHEDULE_PRIORITY_MAX,
  type AssetView,
  type ScheduleChangePreview,
  type ScheduleKind,
  type ScheduleView,
} from '@game-admin/shared';
import { api, ApiError, uploadFile } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ReasonField } from '../../shared/components/ReasonField';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { FREQUENCY_LABEL, KIND_LABEL, StatusTag, fmtPeriod, useRankingBoards } from './common';

interface Values {
  kind: ScheduleKind;
  rankingBoardId?: number;
  title: string;
  description: string;
  period: [Dayjs, Dayjs];
  popupEnabled: boolean;
  popupFrequency: keyof typeof FREQUENCY_LABEL;
  bannerEnabled: boolean;
  priority: number;
  link?: string;
  reason: string;
}

const LINK_PATTERN = /^(game:\/\/[A-Za-z0-9._~\-/?=&%#]+|https:\/\/[^\s<>"']+)$/;

/** 진행 중 변경(L2)의 영향 미리보기 */
function ChangePreview({ p }: { p: ScheduleChangePreview }) {
  const label = { UPDATE: '수정', CANCEL: '내리기', END_NOW: '조기 종료' }[p.action];
  return (
    <>
      <Descriptions column={1} size="small" bordered style={{ marginBottom: 8 }}>
        <Descriptions.Item label="일정">{p.title}</Descriptions.Item>
        <Descriptions.Item label="작업">{label}</Descriptions.Item>
        <Descriptions.Item label="현재 기간">{fmtPeriod(p.before)}</Descriptions.Item>
        {p.after && <Descriptions.Item label="바뀐 기간">{fmtPeriod(p.after)}</Descriptions.Item>}
      </Descriptions>
      {p.warnings.map((w) => (
        <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 6 }} />
      ))}
    </>
  );
}

/**
 * 일정 편집 서랍 (새로 만들기 / 수정)
 * - 시작 전: 바로 저장(L1) / 진행 중: 영향 확인 후 저장(L2), 시작 시각은 고정 / 종료·취소: 읽기 전용
 */
export function ScheduleEditor({
  open,
  schedule,
  defaultStart,
  onClose,
}: {
  open: boolean;
  /** 없으면 새로 만들기 */
  schedule?: ScheduleView;
  defaultStart?: Dayjs;
  onClose(): void;
}) {
  const [form] = Form.useForm<Values>();
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const run = useSafeAction();
  const queryClient = useQueryClient();
  const boards = useRankingBoards();
  const [image, setImage] = useState<AssetView | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const isNew = !schedule;
  const status = schedule?.status ?? 'SCHEDULED';
  const readOnly = !can(Permission.SCHEDULE_MANAGE) || status === 'ENDED' || status === 'CANCELED';
  const active = status === 'ACTIVE';
  const kind = Form.useWatch('kind', form);
  const popupEnabled = Form.useWatch('popupEnabled', form);
  const bannerEnabled = Form.useWatch('bannerEnabled', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (schedule) {
      form.setFieldsValue({
        kind: schedule.kind,
        title: schedule.title,
        description: schedule.description,
        period: [dayjs(schedule.startsAt), dayjs(schedule.endsAt)],
        popupEnabled: schedule.popupEnabled,
        popupFrequency: schedule.popupFrequency,
        bannerEnabled: schedule.bannerEnabled,
        priority: schedule.priority,
        link: schedule.link ?? undefined,
      });
      setImage(schedule.image);
    } else {
      const start = (defaultStart ?? dayjs().add(1, 'day')).hour(10).minute(0).second(0);
      form.setFieldsValue({
        kind: 'EVENT',
        rankingBoardId: 1,
        description: '',
        period: [start, start.add(7, 'day')],
        popupEnabled: false,
        popupFrequency: 'DAILY',
        bannerEnabled: false,
        priority: 0,
      });
      setImage(null);
    }
  }, [open, schedule, defaultStart, form]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    void queryClient.invalidateQueries({ queryKey: ['ranking-seasons'] });
  };

  async function onUpload(file: File) {
    if (file.size > IMAGE_MAX_BYTES) {
      void message.error(`이미지는 ${IMAGE_MAX_BYTES / 1024 / 1024}MB 까지 올릴 수 있습니다.`);
      return;
    }
    setUploading(true);
    try {
      setImage(await uploadFile<AssetView>('/assets', file));
    } catch (err) {
      void message.error(err instanceof ApiError ? err.message : '업로드에 실패했습니다.');
    } finally {
      setUploading(false);
    }
  }

  const bodyOf = (v: Values) => ({
    title: v.title,
    description: v.description ?? '',
    startsAt: v.period[0].toISOString(),
    endsAt: v.period[1].toISOString(),
    popupEnabled: v.popupEnabled,
    popupFrequency: v.popupFrequency,
    bannerEnabled: v.bannerEnabled,
    priority: v.priority ?? 0,
    imageAssetId: image?.id ?? null,
    link: v.link?.trim() ? v.link.trim() : null,
    reason: v.reason,
  });

  async function save() {
    const v = await form.validateFields();
    setSaving(true);
    const res = isNew
      ? await run<ScheduleView>({
          request: ({ idempotencyKey }) =>
            api.post(
              '/schedules',
              {
                kind: v.kind,
                ...bodyOf(v),
                ...(v.kind === 'RANKING_SEASON' ? { rankingBoardId: v.rankingBoardId } : {}),
              },
              { idempotencyKey },
            ),
          successMessage: '일정을 등록했습니다.',
        })
      : await run<ScheduleView>({
          request: ({ confirmationToken }) =>
            api.put(`/schedules/${schedule.id}`, {
              ...bodyOf(v),
              version: schedule.version,
              ...(confirmationToken ? { confirmationToken } : {}),
            }),
          confirmTitle: '진행 중 일정 수정',
          renderPreview: (p) => <ChangePreview p={p as ScheduleChangePreview} />,
          successMessage: '저장했습니다.',
        });
    setSaving(false);
    if (res) {
      refresh();
      onClose();
    }
  }

  /** 취소(시작 전) / 내리기(진행 중 이벤트) / 조기 종료(진행 중 시즌) — 사유를 먼저 받는다 */
  function action(kind: 'cancel' | 'end-now') {
    if (!schedule) return;
    let reason = '';
    const title = kind === 'end-now' ? '시즌 조기 종료' : active ? '이벤트 내리기' : '일정 취소';
    void modal.confirm({
      title,
      content: (
        <>
          <Typography.Paragraph>
            {kind === 'end-now'
              ? '지금 시즌을 끝내고 최종 순위 스냅샷을 만듭니다. 다음 단계에서 영향을 한 번 더 확인합니다.'
              : active
                ? '게임에서 바로 사라집니다. 다음 단계에서 한 번 더 확인합니다.'
                : '아직 시작 전이라 게임에 나간 적이 없습니다. 바로 취소됩니다.'}
          </Typography.Paragraph>
          <Input.TextArea
            rows={2}
            placeholder="사유 (5자 이상, 운영 로그에 기록)"
            onChange={(e) => (reason = e.target.value)}
          />
        </>
      ),
      okText: kind === 'end-now' ? '다음' : active ? '다음' : '취소하기',
      okButtonProps: { danger: true },
      cancelText: '닫기',
      onOk: async () => {
        if (reason.trim().length < 5) {
          void message.error('사유를 5자 이상 입력하세요.');
          throw new Error('reason');
        }
        const res = await run({
          request: ({ confirmationToken }) =>
            api.post(`/schedules/${schedule.id}/${kind}`, {
              reason: reason.trim(),
              version: schedule.version,
              ...(confirmationToken ? { confirmationToken } : {}),
            }),
          confirmTitle: title,
          renderPreview: (p) => <ChangePreview p={p as ScheduleChangePreview} />,
          successMessage:
            kind === 'end-now'
              ? '시즌을 종료했습니다. 랭킹 → 스냅샷에서 보상을 지급할 수 있습니다.'
              : '처리했습니다.',
          onError: (err) => {
            if (err.code !== 'VERSION_CONFLICT') return false;
            void message.error(err.message);
            refresh();
            onClose();
            return true;
          },
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
      width={560}
      onClose={onClose}
      title={
        isNew ? (
          '일정 추가'
        ) : (
          <Space>
            {schedule.title} <StatusTag status={status} />
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
          <Space>
            {active && schedule.kind === 'RANKING_SEASON' ? (
              <Button danger icon={<StopOutlined />} onClick={() => action('end-now')}>
                조기 종료
              </Button>
            ) : (
              <Button danger icon={<DeleteOutlined />} onClick={() => action('cancel')}>
                {active ? '내리기' : '일정 취소'}
              </Button>
            )}
          </Space>
        )
      }
      destroyOnHidden
    >
      {readOnly && !isNew && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            status === 'ENDED'
              ? '종료된 일정은 바꿀 수 없습니다 (기록 보존).'
              : status === 'CANCELED'
                ? '취소된 일정입니다.'
                : '조회 권한만 있습니다.'
          }
        />
      )}
      {active && !readOnly && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="진행 중인 일정입니다"
          description="시작 시각은 바꿀 수 없고, 저장하기 전에 영향을 한 번 더 확인합니다. 게임에는 바로 반영됩니다."
        />
      )}

      <Form<Values> form={form} layout="vertical" disabled={readOnly} requiredMark="optional">
        <Form.Item name="kind" label="종류">
          <Select
            disabled={!isNew}
            style={{ width: 200 }}
            options={(['EVENT', 'RANKING_SEASON'] as const).map((k) => ({
              value: k,
              label: KIND_LABEL[k],
            }))}
          />
        </Form.Item>
        {kind === 'RANKING_SEASON' &&
          (isNew ? (
            <Form.Item
              name="rankingBoardId"
              label="랭킹 종류"
              rules={[{ required: true, message: '랭킹 종류를 고르세요.' }]}
              extra="같은 랭킹 안에서만 시즌 기간이 겹치면 안 됩니다. 다른 랭킹끼리는 동시에 열 수 있어요."
            >
              <Select
                style={{ width: 200 }}
                loading={boards.isLoading}
                placeholder="아레나 / 월드아레나"
                options={boards.data?.map((b) => ({ value: b.id, label: b.name }))}
              />
            </Form.Item>
          ) : (
            <Form.Item label="랭킹 종류">
              <Typography.Text strong>{schedule?.rankingSeason?.board.name ?? '-'}</Typography.Text>
            </Form.Item>
          ))}
        {kind === 'RANKING_SEASON' && isNew && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="랭킹 시즌은 시작 시각에 자동으로 열리고, 종료 시각에 닫히며 최종 순위가 저장됩니다"
            description="다른 시즌과 기간이 겹칠 수 없습니다. 제목이 시즌 이름이 됩니다."
          />
        )}
        <Form.Item
          name="title"
          label={kind === 'RANKING_SEASON' ? '시즌 이름' : '제목'}
          rules={[{ required: true, whitespace: true }, { max: 50 }]}
        >
          <Input
            showCount
            maxLength={50}
            placeholder={kind === 'RANKING_SEASON' ? '예: 아레나 시즌 2' : '예: 경험치 2배 주말'}
          />
        </Form.Item>
        <Form.Item name="description" label="설명" extra="팝업에 함께 보입니다">
          <Input.TextArea rows={3} showCount maxLength={1000} />
        </Form.Item>
        <Form.Item
          name="period"
          label="기간 (한국 시간)"
          rules={[
            { required: true, message: '기간을 정하세요.' },
            {
              validator: async (_, v?: [Dayjs, Dayjs]) => {
                if (v && !v[1].isAfter(v[0])) throw new Error('종료는 시작보다 뒤여야 합니다.');
                if (v && isNew && !v[1].isAfter(dayjs())) throw new Error('이미 끝난 기간입니다.');
              },
            },
          ]}
        >
          <DatePicker.RangePicker
            showTime={{ format: 'HH:mm' }}
            format="YYYY-MM-DD HH:mm"
            style={{ width: '100%' }}
            disabled={active ? [true, false] : undefined}
          />
        </Form.Item>

        <Divider orientation="left" plain>
          게임 노출
        </Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="popupEnabled" label="팝업" valuePropName="checked">
              <Switch />
            </Form.Item>
            {popupEnabled && (
              <Form.Item name="popupFrequency" label="팝업 빈도">
                <Select
                  options={Object.entries(FREQUENCY_LABEL).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
            )}
          </Col>
          <Col span={12}>
            <Form.Item name="bannerEnabled" label="로비 배너" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="priority" label="우선순위" tooltip="높을수록 먼저 (팝업·배너 공통)">
              <InputNumber<number> min={0} max={SCHEDULE_PRIORITY_MAX} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label="이미지"
          required={bannerEnabled}
          extra={`PNG·JPEG·WebP, ${IMAGE_MAX_BYTES / 1024 / 1024}MB·${IMAGE_MAX_PIXELS}px 이하 (SVG 불가)${bannerEnabled ? ' — 배너에는 필수' : ''}`}
          validateStatus={bannerEnabled && !image ? 'error' : undefined}
          help={bannerEnabled && !image ? '배너에는 이미지가 필요합니다.' : undefined}
        >
          <Space align="start">
            {image && (
              <Image
                src={image.url}
                width={160}
                height={90}
                style={{ objectFit: 'cover', borderRadius: 6 }}
              />
            )}
            {!readOnly && (
              <Space direction="vertical">
                <Upload
                  accept="image/png,image/jpeg,image/webp"
                  showUploadList={false}
                  beforeUpload={(f) => {
                    void onUpload(f);
                    return false;
                  }}
                >
                  <Button icon={<UploadOutlined />} loading={uploading}>
                    {image ? '바꾸기' : '올리기'}
                  </Button>
                </Upload>
                {image && (
                  <Button
                    size="small"
                    type="link"
                    danger
                    onClick={() => setImage(null)}
                    style={{ padding: 0 }}
                  >
                    이미지 빼기
                  </Button>
                )}
                {image && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {image.width}×{image.height}
                  </Typography.Text>
                )}
              </Space>
            )}
          </Space>
        </Form.Item>
        <Form.Item
          name="link"
          label="눌렀을 때 이동"
          extra="게임 안 이동은 game://shop 처럼, 외부는 https:// 만"
          rules={[{ pattern: LINK_PATTERN, message: 'game:// 또는 https:// 로 시작해야 합니다.' }]}
        >
          <Input placeholder="game://event/123" allowClear />
        </Form.Item>
        {!readOnly && <ReasonField />}
      </Form>

      {schedule && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          등록 {schedule.createdBy.name} · {dayjs(schedule.createdAt).format('YYYY-MM-DD HH:mm')} /
          마지막 수정 {schedule.updatedBy.name} ·{' '}
          {dayjs(schedule.updatedAt).format('YYYY-MM-DD HH:mm')}
          {schedule.rankingSeason && ` · 시즌 #${schedule.rankingSeason.id}`}
        </Typography.Paragraph>
      )}
    </Drawer>
  );
}
