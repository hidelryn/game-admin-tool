import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Flex, Input, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  LoadingOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  ASSISTANT_MAX_TURNS,
  ASSISTANT_QUESTION_MAX,
  type AssistantChart as Chart,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantStatus,
} from '@game-admin/shared';
import { api, ApiError, postStream } from '../../shared/api/client';
import { AssistantChart } from './AssistantChart';

interface Step {
  name: string;
  label: string;
  state: 'running' | 'ok' | 'fail';
}
type Turn =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      charts: Chart[];
      steps: Step[];
      error?: string;
      pending?: boolean;
    };

const SUGGESTIONS = [
  '최근 2주 DAU 추이 보여줘',
  '이탈이 가장 많은 스테이지 구간은?',
  '이번 달 매출과 잘 팔린 상품 알려줘',
  '골드를 어디에 가장 많이 썼어?',
];

export const ASSISTANT_PANEL_WIDTH = 400;

/**
 * AI 어시스턴트 패널 (docs/ai-assistant.md)
 * - 대화는 이 패널이 열려 있는 동안만 (서버에 저장하지 않음)
 * - AI 는 조회만 한다. 답의 차트는 서버가 숫자를 검증한 것만 온다
 */
export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const status = useQuery({
    queryKey: ['assistant', 'status'],
    queryFn: async () => (await api.get<AssistantStatus>('/assistant/status')).data,
    staleTime: 60_000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);

  /** 마지막(진행 중) 답변 갱신 */
  const patchLast = (fn: (t: Extract<Turn, { role: 'assistant' }>) => void) =>
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        const copy = { ...last, steps: [...last.steps], charts: [...last.charts] };
        fn(copy);
        next[next.length - 1] = copy;
      }
      return next;
    });

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    // 서버로 보낼 대화: 실패한 답은 빼고, 최근 것만
    const history: AssistantMessage[] = turns
      .filter((t) => t.role === 'user' || (!t.error && t.text))
      .map((t) => ({ role: t.role, content: t.text }))
      .slice(-(ASSISTANT_MAX_TURNS * 2 - 1));
    if (history[0]?.role === 'assistant') history.shift();
    setTurns((prev) => [
      ...prev,
      { role: 'user', text: q },
      { role: 'assistant', text: '', charts: [], steps: [], pending: true },
    ]);
    setDraft('');
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await postStream<AssistantEvent>(
        '/assistant/chat',
        { messages: [...history, { role: 'user', content: q }] },
        (e) => {
          if (e.type === 'tool')
            patchLast((t) => t.steps.push({ name: e.name, label: e.label, state: 'running' }));
          else if (e.type === 'tool_done')
            patchLast((t) => {
              const i = t.steps.findLastIndex((s) => s.name === e.name && s.state === 'running');
              if (i >= 0) t.steps[i] = { ...t.steps[i]!, state: e.ok ? 'ok' : 'fail' };
            });
          else if (e.type === 'answer')
            patchLast((t) => {
              t.text = e.text;
              t.charts = e.charts;
            });
          else if (e.type === 'error') patchLast((t) => (t.error = e.message));
        },
        abort.signal,
      );
    } catch (err) {
      const message = abort.signal.aborted
        ? '중단했습니다.'
        : err instanceof ApiError
          ? err.message
          : '응답을 받지 못했습니다.';
      patchLast((t) => (t.error = message));
    } finally {
      patchLast((t) => (t.pending = false));
      setBusy(false);
      abortRef.current = null;
    }
  }

  const reset = () => {
    abortRef.current?.abort();
    setTurns([]);
  };
  const s = status.data;

  return (
    <Flex
      vertical
      style={{
        width: ASSISTANT_PANEL_WIDTH,
        maxWidth: '100vw',
        height: '100vh',
        background: '#fff',
        borderLeft: '1px solid #f0f0f0',
      }}
    >
      <Flex
        align="center"
        justify="space-between"
        style={{ padding: '14px 16px', borderBottom: '1px solid #f0f0f0' }}
      >
        <Space>
          <RobotOutlined style={{ color: '#2a5bd7' }} />
          <Typography.Text strong>AI 어시스턴트</Typography.Text>
          <Tag style={{ marginInlineEnd: 0 }}>조회 전용</Tag>
        </Space>
        <Space size={4}>
          <Tooltip title="새 대화">
            <Button type="text" size="small" icon={<PlusOutlined />} onClick={reset} />
          </Tooltip>
          <Tooltip title="닫기 (대화는 지워져요)">
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
          </Tooltip>
        </Space>
      </Flex>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {status.isLoading ? (
          <Spin />
        ) : s && !s.configured ? (
          <Alert
            type="info"
            showIcon
            message="AI 어시스턴트가 설정되지 않았어요"
            description="서버 .env 에 ANTHROPIC_API_KEY 를 넣으면 사용할 수 있습니다."
          />
        ) : turns.length === 0 ? (
          <Empty
            tools={s?.tools.map((t) => t.label) ?? []}
            demoPerDay={s?.limits.demoPerIpDay ?? null}
            onPick={ask}
          />
        ) : (
          turns.map((t, i) =>
            t.role === 'user' ? (
              <Flex key={i} justify="flex-end" style={{ marginBottom: 12 }}>
                <div
                  style={{
                    maxWidth: '85%',
                    background: '#2a5bd7',
                    color: '#fff',
                    padding: '8px 12px',
                    borderRadius: '12px 12px 2px 12px',
                    whiteSpace: 'pre-wrap',
                    fontSize: 14,
                  }}
                >
                  {t.text}
                </div>
              </Flex>
            ) : (
              <div key={i} style={{ marginBottom: 16 }}>
                {t.steps.length > 0 && (
                  <Flex wrap gap={4} style={{ marginBottom: 6 }}>
                    {t.steps.map((st, j) => (
                      <Tag
                        key={j}
                        icon={
                          st.state === 'running' ? (
                            <LoadingOutlined />
                          ) : st.state === 'ok' ? (
                            <CheckCircleOutlined />
                          ) : (
                            <CloseCircleOutlined />
                          )
                        }
                        color={st.state === 'fail' ? 'error' : 'default'}
                      >
                        {st.label}
                      </Tag>
                    ))}
                  </Flex>
                )}
                <div
                  style={{
                    background: '#f5f6fa',
                    padding: '10px 12px',
                    borderRadius: '12px 12px 12px 2px',
                  }}
                >
                  {t.pending && !t.text && !t.error && (
                    <Typography.Text type="secondary">
                      <LoadingOutlined />{' '}
                      {t.steps.length ? '결과를 정리하는 중…' : '질문을 이해하는 중…'}
                    </Typography.Text>
                  )}
                  {t.text && (
                    <Typography.Paragraph
                      style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}
                    >
                      {t.text}
                    </Typography.Paragraph>
                  )}
                  {t.charts.map((c, j) => (
                    <AssistantChart key={j} chart={c} />
                  ))}
                  {t.error && (
                    <Typography.Text type="danger" style={{ fontSize: 13 }}>
                      {t.error}
                    </Typography.Text>
                  )}
                </div>
              </div>
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ padding: 12, borderTop: '1px solid #f0f0f0' }}>
        <Flex gap={8} align="flex-end">
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={(e) => {
              if (e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void ask(draft);
            }}
            placeholder="운영 데이터에 대해 물어보세요 (Shift+Enter 줄바꿈)"
            autoSize={{ minRows: 1, maxRows: 5 }}
            maxLength={ASSISTANT_QUESTION_MAX}
            disabled={!s?.configured}
          />
          {busy ? (
            <Button icon={<StopOutlined />} onClick={() => abortRef.current?.abort()} />
          ) : (
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => void ask(draft)}
              disabled={!draft.trim() || !s?.configured}
            />
          )}
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
          AI 답변은 틀릴 수 있어요. 중요한 판단은 각 메뉴의 원본 데이터로 확인하세요.
        </Typography.Text>
      </div>
    </Flex>
  );
}

function Empty(props: { tools: string[]; demoPerDay: number | null; onPick: (q: string) => void }) {
  return (
    <div>
      <Typography.Paragraph style={{ fontSize: 14 }}>
        질문하면 필요한 데이터를 직접 찾아 조회하고, 요약과 차트로 정리해 드려요.
      </Typography.Paragraph>
      <Flex vertical gap={6} style={{ marginBottom: 16 }}>
        {SUGGESTIONS.map((q) => (
          <Button
            key={q}
            onClick={() => props.onPick(q)}
            style={{ textAlign: 'left', height: 'auto', whiteSpace: 'normal' }}
          >
            {q}
          </Button>
        ))}
      </Flex>
      {props.tools.length > 0 && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          볼 수 있는 데이터: {props.tools.join(' · ')}
        </Typography.Paragraph>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        지급·정지·발송 같은 변경은 하지 않아요. 내 권한으로 볼 수 있는 것만 조회합니다.
        {props.demoPerDay ? ` 체험 계정은 하루 ${props.demoPerDay}번까지 질문할 수 있어요.` : ''}
      </Typography.Paragraph>
    </div>
  );
}
