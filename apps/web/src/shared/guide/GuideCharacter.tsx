import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { attachHaru, DetachedError, type Framing } from './live2d-stage';

/**
 * 표정(분위기) — 쓰는 쪽(로그인 화면·투어) 호환용.
 * 샘플 모델에는 표정 파일이 없어서, normal 이 아니면 바뀔 때 몸짓 모션을 하나 재생한다.
 */
export type GuideExpression = 'normal' | 'smile' | 'wink' | 'alert';

/** 안내 캐릭터 이름 — 로그인 화면·투어 말풍선에서 쓴다 */
export const GUIDE_NAME = '하루';

/** 모델 저작권 표기 (Live2D 무상 제공 머티리얼) */
export const GUIDE_CREDIT = 'Live2D 샘플 모델 「하루」 © Live2D Inc.';

/**
 * 안내 캐릭터 — Live2D 샘플 "하루(접수원 버전)"
 * 불러오는 중이거나 실패하면(모델 파일 없음·WebGL 미지원·CDN 차단) 같은 크기의 자리표시를 보여 준다.
 * 클릭하면 몸짓 모션.
 */
export function GuideCharacter({
  expression = 'normal',
  size = 240,
  framing,
  style,
}: {
  expression?: GuideExpression;
  /** 세로 px */
  size?: number;
  /** 기본: 160px 이상이면 전신, 아니면 상반신 */
  framing?: Framing;
  style?: CSSProperties;
}) {
  const frame: Framing = framing ?? (size >= 160 ? 'full' : 'bust');
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<Awaited<ReturnType<typeof attachHaru>> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [width, setWidth] = useState<number>(frame === 'bust' ? Math.round(size * 0.9) : Math.round(size * 0.6));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    attachHaru(el, { height: size, framing: frame })
      .then((h) => {
        if (!alive) return h.detach();
        handle.current = h;
        setWidth(h.width);
        setState('ready');
      })
      .catch((e: unknown) => {
        if (!alive || e instanceof DetachedError) return;
        console.warn('[guide] Live2D 캐릭터를 띄우지 못했습니다:', e);
        setState('failed');
      });
    return () => {
      alive = false;
      handle.current?.detach();
      handle.current = null;
    };
  }, [size, frame]);

  // 분위기가 바뀌면 몸짓 하나
  useEffect(() => {
    if (state === 'ready' && expression !== 'normal') handle.current?.gesture();
  }, [expression, state]);

  return (
    <div
      role="img"
      aria-label={`안내 캐릭터 ${GUIDE_NAME}`}
      title={state === 'ready' ? `${GUIDE_NAME} (클릭하면 인사해요)` : undefined}
      onClick={() => handle.current?.gesture()}
      style={{
        position: 'relative',
        width,
        height: size,
        flex: 'none',
        cursor: state === 'ready' ? 'pointer' : undefined,
        ...style,
      }}
    >
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      {state !== 'ready' && <Placeholder size={size} failed={state === 'failed'} />}
    </div>
  );
}

/** 불러오는 중·실패 시 자리표시 (이름 배지) */
function Placeholder({ size, failed }: { size: number; failed: boolean }) {
  const d = Math.min(size * 0.6, 120);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: d,
          height: d,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #ffd6e0, #c9d8ff)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#3b4566',
          fontWeight: 600,
          fontSize: d * 0.22,
          opacity: failed ? 1 : 0.6,
          animation: failed ? undefined : 'guide-pulse 1.4s ease-in-out infinite',
        }}
      >
        {GUIDE_NAME}
        <style>{'@keyframes guide-pulse{50%{opacity:.35}}'}</style>
      </div>
    </div>
  );
}

/** 말풍선 (캐릭터 옆) */
export function SpeechBubble({
  children,
  side = 'left',
  style,
}: {
  children: ReactNode;
  /** 꼬리 방향 (캐릭터가 있는 쪽) */
  side?: 'left' | 'top';
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: 'relative',
        background: '#fff',
        border: '1px solid #c9d0e3',
        borderRadius: 12,
        padding: '12px 16px',
        color: '#1d2340',
        lineHeight: 1.6,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          width: 12,
          height: 12,
          background: '#fff',
          borderLeft: '1px solid #c9d0e3',
          borderBottom: '1px solid #c9d0e3',
          ...(side === 'left'
            ? { left: -7, top: 22, transform: 'rotate(45deg)' }
            : { top: -7, left: 28, transform: 'rotate(135deg)' }),
        }}
      />
      {children}
    </div>
  );
}
