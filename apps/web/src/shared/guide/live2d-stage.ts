/**
 * Live2D 안내 캐릭터 "하루" 무대 (싱글턴)
 *
 * - 모델: Live2D 공식 무료 샘플 "하루(접수원 버전)" — public/live2d/haru/ (git 미포함, docs/live2d.md 참고)
 * - Cubism Core 는 공식 CDN 에서 처음 필요할 때만 불러온다 (SDK 파일을 저장소에 넣지 않음)
 * - pixi.js + pixi-live2d-display 는 동적 import — 캐릭터가 보이는 화면에서만 받는다
 * - 캔버스(WebGL 컨텍스트)는 하나만 만들고, 보여 줄 자리(로그인 화면·투어 말풍선)로 옮겨 붙인다.
 *   투어 단계가 바뀔 때마다 모델을 다시 읽지 않기 위해서다.
 */
import type { Application } from 'pixi.js';
import type { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4';

const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
const MODEL_DIR = '/live2d/haru/';
const MODEL_FILE = 'haru_greeter_t05.model3.json';
/** 원본 model3.json 은 모션이 전부 이름 없는 그룹("")에 있다 — 대기(idle)와 동작을 나눠서 쓴다 */
const IDLE_FILE = 'motion/haru_g_idle.motion3.json';

export type Framing = 'full' | 'bust';

interface Stage {
  app: Application;
  model: Live2DModel;
  /** 모델 원본 크기 (scale 1 기준) */
  baseW: number;
  baseH: number;
  gestureCount: number;
}

let corePromise: Promise<void> | null = null;
let stagePromise: Promise<Stage> | null = null;
/** 지금 캔버스를 차지한 자리 — 마지막에 붙은 쪽이 주인 (StrictMode 이중 마운트 대비) */
let owner: symbol | null = null;

function loadCubismCore(): Promise<void> {
  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore)
    return Promise.resolve();
  corePromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CUBISM_CORE_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      corePromise = null; // 다음에 다시 시도할 수 있게
      s.remove();
      reject(new Error('Cubism Core 를 불러오지 못했습니다'));
    };
    document.head.appendChild(s);
  });
  return corePromise;
}

async function createStage(): Promise<Stage> {
  await loadCubismCore();
  const [PIXI, { Live2DModel }] = await Promise.all([
    import('pixi.js'),
    import('pixi-live2d-display-lipsyncpatch/cubism4'),
  ]);

  // 원본 설정 파일은 그대로 두고, 읽은 뒤 모션 그룹만 Idle / Gesture 로 나눈다
  const res = await fetch(MODEL_DIR + MODEL_FILE);
  if (!res.ok) throw new Error(`모델 파일이 없습니다 (${res.status})`);
  const settings = (await res.json()) as {
    url?: string;
    FileReferences: { Motions?: Record<string, { File: string }[]> };
  };
  const all = Object.values(settings.FileReferences.Motions ?? {}).flat();
  const idle = all.filter((m) => m.File === IDLE_FILE);
  const gestures = all.filter((m) => m.File !== IDLE_FILE);
  settings.FileReferences.Motions = { Idle: idle, Gesture: gestures };
  settings.url = MODEL_DIR + MODEL_FILE;

  const app = new PIXI.Application({
    width: 1,
    height: 1,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoStart: false,
  });
  const model = await Live2DModel.from(settings, {
    ticker: app.ticker,
    autoFocus: !prefersReducedMotion(), // 마우스 쪽으로 시선·고개
    autoHitTest: false,
  });
  model.scale.set(1);
  const baseW = model.width;
  const baseH = model.height;
  model.anchor.set(0.5, 0);
  app.stage.addChild(model);

  const canvas = app.view as HTMLCanvasElement;
  canvas.style.display = 'block';
  canvas.setAttribute('aria-hidden', 'true');
  return { app, model, baseW, baseH, gestureCount: gestures.length };
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 표시 영역 크기 — bust 는 상반신(위쪽 45%)만 */
export function frameSize(baseW: number, baseH: number, height: number, framing: Framing) {
  if (framing === 'bust') {
    const scale = height / (baseH * 0.45);
    return { width: Math.round(height * 0.9), height, scale };
  }
  const scale = height / baseH;
  return { width: Math.round(baseW * scale), height, scale };
}

/**
 * container 에 캐릭터를 붙인다. 떼어 낼 함수를 돌려준다.
 * 실패하면 예외 (호출하는 쪽에서 대체 이미지를 보여 준다).
 */
export async function attachHaru(
  container: HTMLElement,
  opts: { height: number; framing: Framing },
): Promise<{ detach(): void; gesture(): void; width: number }> {
  const token = Symbol('haru');
  owner = token;
  stagePromise ??= createStage().catch((e: unknown) => {
    stagePromise = null;
    throw e;
  });
  const st = await stagePromise;
  if (owner !== token) throw new DetachedError();

  const { width, height, scale } = frameSize(st.baseW, st.baseH, opts.height, opts.framing);
  st.app.renderer.resize(width, height);
  st.model.scale.set(scale);
  st.model.position.set(width / 2, opts.framing === 'bust' ? height * 0.02 : 0);

  container.appendChild(st.app.view as HTMLCanvasElement);
  st.app.start();

  return {
    width,
    gesture() {
      if (owner !== token || prefersReducedMotion() || st.gestureCount === 0) return;
      void st.model.motion('Gesture', Math.floor(Math.random() * st.gestureCount));
    },
    detach() {
      if (owner !== token) return;
      owner = null;
      st.app.stop();
      (st.app.view as HTMLCanvasElement).remove();
    },
  };
}

/** 붙기 전에 다른 자리가 캔버스를 가져갔다 (정상 흐름) */
export class DetachedError extends Error {}
