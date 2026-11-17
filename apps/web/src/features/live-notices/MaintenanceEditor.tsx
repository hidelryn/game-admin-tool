import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Typography,
} from 'antd';
import { DeleteOutlined, UnlockOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  MAINTENANCE_ALLOW_MAX,
  Permission,
  type MaintenanceChangePreview,
  type MaintenanceView,
} from '@game-admin/shared';
import { api } from '../../shared/api/client';
import { useAuth } from '../../shared/auth/AuthProvider';
import { ReasonField } from '../../shared/components/ReasonField';
import { useSafeAction } from '../../shared/safety/useSafeAction';
import { MaintenanceStatusTag, fmt } from './common';

export type EditorMode = 'schedule' | 'emergency';

interface Values {
  title: string;
  message: string;
  period?: [Dayjs, Dayjs];
  endsAt?: Dayjs;
  allowPublicIds: string[];
  createNotice: boolean;
  reason: string;
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,20}$/;

/** 긴급 시작·연장·지금 열기(L2) 확인 화면 */
export function MaintenancePreview({ p }: { p: MaintenanceChangePreview }) {
  const label = { START_NOW: '긴급 점검 시작', EXTEND: '종료 시각 변경', OPEN_NOW: '지금 열기' }[
    p.action
  ];
  return (
    <>
      <Descriptions column={1} size="small" bordered style={{ marginBottom: 8 }}>
        <Descriptions.Item label="점검">{p.title}</Descriptions.Item>
        <Descriptions.Item label="작업">{label}</Descriptions.Item>
        <Descriptions.Item label="기간">
          {fmt(p.startsAt)} ~ {fmt(p.endsAt)}
        </Descriptions.Item>
        {p.action !== 'OPEN_NOW' && (
          <Descriptions.Item label="최근 30분 접속">
            약 {p.recentPlayers.toLocaleString()}명
          </Descriptions.Item>
        )}
      </Descriptions>
      {p.warnings.map((w) => (
        <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 6 }} />
      ))}
    </>
  );
}

/**
 * 점검 편집 서랍
 * - 새 예약 / 긴급(지금 시작, L2)
 * - 예정: 전부 수정·취소 (L1) / 진행 중: 종료 시각(L2)·문구·예외 회원(L1), 지금 열기(L2)
 */
export function MaintenanceEditor({
  open,
  maintenance,
  mode = 'schedule',
  onClose,
}: {
  open: boolean;
  maintenance?: MaintenanceView;
  mode?: EditorMode;
  onClose(): void;
}) {
  const [form] = Form.useForm<Values>();
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const run = useSafeAction();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const isNew = !maintenance;
  const emergency = isNew && mode === 'emergency';
  const status = maintenance?.status ?? 'SCHEDULED';
  const active = status === 'ACTIVE';
  const readOnly =
    !can(Permission.MAINTENANCE_MANAGE) || status === 'ENDED' || status === 'CANCELED';

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (maintenance) {
      form.setFieldsValue({
        title: maintenance.title,
        message: maintenance.message,
        period: [dayjs(maintenance.startsAt), dayjs(maintenance.endsAt)],
        endsAt: dayjs(maintenance.endsAt),
        allowPublicIds: maintenance.allowPublicIds,
      });
    } else {
      const start = dayjs().add(1, 'day').hour(4).minute(0).second(0);
      form.setFieldsValue({
        title: emergency ? '긴급 점검' : '정기 점검',
        message: emergency
          ? '원활한 서비스를 위해 긴급 점검을 진행합니다. 이용에 불편을 드려 죄송합니다.'
          : '더 나은 서비스를 위해 정기 점검을 진행합니다.',
        period: [start, start.add(2, 'hour')],
        endsAt: dayjs().add(1, 'hour').second(0),
        allowPublicIds: [],
        createNotice: true,
      });
    }
  }, [open, maintenance, emergency, form]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['maintenances'] });
    void queryClient.invalidateQueries({ queryKey: ['maintenance-current'] });
    void queryClient.invalidateQueries({ queryKey: ['notices'] });
  };

  const onConflict = (err: { code: string; message: string }) => {
    if (err.code !== 'VERSION_CONFLICT') return false;
    void message.error(err.message);
    refresh();
    onClose();
    return true;
  };

  async function save() {
    const v = await form.validateFields();
    const allowPublicIds = [...new Set(v.allowPublicIds.map((s) => s.trim()))];
    setSaving(true);
    let res;
    if (isNew) {
      res = await run<MaintenanceView>({
        request: ({ idempotencyKey, confirmationToken }) =>
          api.post(
            '/maintenances',
            {
              title: v.title,
              message: v.message,
              ...(emergency
                ? { startNow: true, endsAt: v.endsAt!.toISOString() }
                : { startsAt: v.period![0].toISOString(), endsAt: v.period![1].toISOString() }),
              allowPublicIds,
              createNotice: v.createNotice,
              reason: v.reason,
              ...(confirmationToken ? { confirmationToken } : {}),
            },
            { idempotencyKey },
          ),
        confirmTitle: '긴급 점검 시작',
        renderPreview: (p) => <MaintenancePreview p={p as MaintenanceChangePreview} />,
        successMessage: emergency
          ? '점검을 시작했습니다. 게임 접속이 막혔습니다.'
          : '점검을 예약했습니다.',
      });
    } else {
      res = await run<MaintenanceView>({
        request: ({ confirmationToken }) =>
          api.put(`/maintenances/${maintenance.id}`, {
            title: v.title,
            message: v.message,
            startsAt: active ? maintenance.startsAt : v.period![0].toISOString(),
            endsAt: active ? v.endsAt!.toISOString() : v.period![1].toISOString(),
            allowPublicIds,
            reason: v.reason,
            version: maintenance.version,
            ...(confirmationToken ? { confirmationToken } : {}),
          }),
        confirmTitle: '진행 중 점검 종료 시각 변경',
        renderPreview: (p) => <MaintenancePreview p={p as MaintenanceChangePreview} />,
        successMessage: '저장했습니다.',
        onError: onConflict,
      });
    }
    setSaving(false);
    if (res) {
      refresh();
      onClose();
    }
  }

  /** 취소(예정) / 지금 열기(진행 중) — 사유 먼저 */
  function action(kind: 'cancel' | 'open-now') {
    if (!maintenance) return;
    let reason = '';
    const title = kind === 'open-now' ? '점검 지금 열기' : '점검 취소';
    void modal.confirm({
      title,
      content: (
        <>
          <Typography.Paragraph>
            {kind === 'open-now'
              ? '예정보다 일찍 점검을 끝내고 게임 접속을 엽니다. 다음 단계에서 한 번 더 확인합니다.'
              : '시작 전 점검을 취소합니다. 함께 만든 점검 공지도 내려갑니다.'}
          </Typography.Paragraph>
          <Input.TextArea
            rows={2}
            placeholder="사유 (5자 이상, 운영 로그에 기록)"
            onChange={(e) => (reason = e.target.value)}
          />
        </>
      ),
      okText: kind === 'open-now' ? '다음' : '취소하기',
      okButtonProps: { danger: kind === 'cancel' },
      cancelText: '닫기',
      onOk: async () => {
        if (reason.trim().length < 5) {
          void message.error('사유를 5자 이상 입력하세요.');
          throw new Error('reason');
        }
        const res = await run({
          request: ({ confirmationToken }) =>
            api.post(`/maintenances/${maintenance.id}/${kind}`, {
              reason: reason.trim(),
              version: maintenance.version,
              ...(confirmationToken ? { confirmationToken } : {}),
            }),
          confirmTitle: title,
          renderPreview: (p) => <MaintenancePreview p={p as MaintenanceChangePreview} />,
          successMessage:
            kind === 'open-now' ? '점검을 끝내고 접속을 열었습니다.' : '취소했습니다.',
          onError: onConflict,
        });
        if (res) {
          refresh();
          onClose();
        }
      },
    });
  }

  const drawerTitle = isNew ? (
    emergency ? (
      <Typography.Text type="danger" strong>
        긴급 점검 (지금 시작)
      </Typography.Text>
    ) : (
      '점검 예약'
    )
  ) : (
    <Space>
      {maintenance.title} <MaintenanceStatusTag status={status} />
    </Space>
  );

  return (
    <Drawer
      open={open}
      width={560}
      onClose={onClose}
      title={drawerTitle}
      extra={
        !readOnly && (
          <Button type="primary" danger={emergency} loading={saving} onClick={save}>
            {emergency ? '다음 (영향 확인)' : '저장'}
          </Button>
        )
      }
      footer={
        !isNew &&
        !readOnly && (
          <Space>
            {active ? (
              <Button icon={<UnlockOutlined />} onClick={() => action('open-now')}>
                지금 열기
              </Button>
            ) : (
              <Button danger icon={<DeleteOutlined />} onClick={() => action('cancel')}>
                점검 취소
              </Button>
            )}
          </Space>
        )
      }
      destroyOnHidden
    >
      {emergency && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="저장하면 바로 게임 접속이 막히고, 접속 중인 유저의 연결이 모두 끊깁니다"
          description="다음 단계에서 최근 접속자 수를 확인한 뒤 실행합니다. 운영자 백오피스는 계속 쓸 수 있습니다."
        />
      )}
      {active && !readOnly && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="진행 중인 점검입니다"
          description="종료 시각을 바꾸면 영향 확인 후 저장합니다. 문구·예외 회원은 바로 반영됩니다."
        />
      )}
      {readOnly && !isNew && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            status === 'ENDED'
              ? '끝난 점검은 바꿀 수 없습니다 (기록 보존).'
              : status === 'CANCELED'
                ? '취소된 점검입니다.'
                : '조회 권한만 있습니다.'
          }
        />
      )}

      <Form<Values> form={form} layout="vertical" disabled={readOnly} requiredMark="optional">
        <Form.Item
          name="title"
          label="제목"
          rules={[{ required: true, whitespace: true }, { max: 50 }]}
        >
          <Input showCount maxLength={50} />
        </Form.Item>
        <Form.Item
          name="message"
          label="유저 안내 문구"
          extra="게임 로그인 화면과 점검 공지에 보입니다 (평문)"
          rules={[{ required: true, whitespace: true }, { max: 500 }]}
        >
          <Input.TextArea rows={3} showCount maxLength={500} />
        </Form.Item>

        {emergency || active ? (
          <Form.Item
            name="endsAt"
            label="종료 예정 (한국 시간)"
            extra={active ? `시작 ${fmt(maintenance!.startsAt)} (변경 불가)` : '시작은 지금'}
            rules={[
              { required: true, message: '종료 예정 시각을 정하세요.' },
              {
                validator: async (_, v?: Dayjs) => {
                  if (v && !v.isAfter(dayjs())) throw new Error('지금 이후여야 합니다.');
                },
              },
            ]}
          >
            <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
          </Form.Item>
        ) : (
          <Form.Item
            name="period"
            label="점검 시간 (한국 시간)"
            rules={[
              { required: true, message: '점검 시간을 정하세요.' },
              {
                validator: async (_, v?: [Dayjs, Dayjs]) => {
                  if (v && !v[1].isAfter(v[0])) throw new Error('종료는 시작보다 뒤여야 합니다.');
                  if (v && !readOnly && !v[0].isAfter(dayjs()))
                    throw new Error(
                      '시작은 지금 이후여야 합니다. 바로 시작하려면 긴급 점검을 쓰세요.',
                    );
                },
              },
            ]}
          >
            <DatePicker.RangePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              style={{ width: '100%' }}
            />
          </Form.Item>
        )}

        <Form.Item
          name="allowPublicIds"
          label="예외 회원 (점검 중에도 접속 허용)"
          extra={`QA·테스트 계정 회원 ID. 붙여넣기·쉼표·엔터로 여러 개 (최대 ${MAINTENANCE_ALLOW_MAX}명)`}
          rules={[
            {
              validator: async (_, v?: string[]) => {
                if (!v) return;
                if (v.length > MAINTENANCE_ALLOW_MAX)
                  throw new Error(`최대 ${MAINTENANCE_ALLOW_MAX}명까지 넣을 수 있습니다.`);
                const bad = v.find((s) => !PUBLIC_ID.test(s.trim()));
                if (bad) throw new Error(`회원 ID 형식이 아닙니다: ${bad}`);
              },
            },
          ]}
        >
          <Select
            mode="tags"
            open={false}
            tokenSeparators={[',', ' ', '\n', '\t']}
            placeholder="예: U000123"
            suffixIcon={null}
          />
        </Form.Item>

        {isNew && (
          <Form.Item name="createNotice" valuePropName="checked">
            <Checkbox>
              점검 공지를 같이 만들기 (지금부터 게시, 목록 상단 고정 + 로비 한 줄 공지)
            </Checkbox>
          </Form.Item>
        )}
        {!readOnly && <ReasonField />}
      </Form>

      {maintenance && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          등록 {maintenance.createdBy.name} · {fmt(maintenance.createdAt)} / 마지막 수정{' '}
          {maintenance.updatedBy.name} · {fmt(maintenance.updatedAt)}
          {maintenance.startedAt && ` · 실제 시작 ${fmt(maintenance.startedAt)}`}
          {maintenance.endedAt && ` · 일찍 연 시각 ${fmt(maintenance.endedAt)}`}
          {maintenance.sessionEpoch !== null && ` · 세션 세대 ${maintenance.sessionEpoch}`}
          {maintenance.notice && ` · 공지 #${maintenance.notice.id}`}
        </Typography.Paragraph>
      )}
    </Drawer>
  );
}
