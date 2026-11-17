import { Alert, Descriptions, Typography } from 'antd';
import { DangerAction, type DangerPreview } from '@game-admin/shared';

const DANGER_ACTIONS = new Set<string>(Object.values(DangerAction));

/** 서버가 준 미리보기가 L3(대규모·되돌리기 어려운 작업) 형태인지 */
export function isDangerPreview(p: unknown): p is DangerPreview {
  return (
    !!p &&
    typeof p === 'object' &&
    DANGER_ACTIONS.has((p as { action?: string }).action ?? '') &&
    Array.isArray((p as { facts?: unknown }).facts)
  );
}

/** L3 확인 화면: 빨간 경고 + 대상 수·금액을 크게 */
export function DangerPreviewView({ p }: { p: DangerPreview }) {
  return (
    <>
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message="대규모 · 되돌리기 어려운 작업입니다"
        description="확인을 누르면 바로 실행됩니다. 대상과 수량을 한 번 더 확인하세요."
      />
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {p.title}
      </Typography.Title>
      <Descriptions column={1} size="small" bordered style={{ marginBottom: 8 }}>
        {p.facts.map((f) => (
          <Descriptions.Item key={f.label} label={f.label}>
            <Typography.Text strong type="danger">
              {f.value}
            </Typography.Text>
          </Descriptions.Item>
        ))}
      </Descriptions>
      {p.warnings.map((w) => (
        <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 6 }} />
      ))}
    </>
  );
}
