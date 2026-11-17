# Live2D 안내 캐릭터 "하루"

로그인 화면과 메뉴 투어의 안내 캐릭터는 Live2D 공식 무료 샘플 **하루(접수원 버전, haru_greeter_t05)** 를 쓴다.

## 구성

| 항목 | 위치·방식 |
|---|---|
| 모델 파일 | `apps/web/public/live2d/haru/` — 샘플 zip 의 `runtime/` 폴더 내용 + `ReadMe.txt` |
| Cubism Core | 공식 CDN `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` 를 처음 필요할 때 주입 (저장소에 넣지 않음) |
| 렌더러 | `pixi.js` 7 + `pixi-live2d-display-lipsyncpatch` 0.5.0-ls-8 (Cubism 4/5 Core 대응 포크). 동적 import 라 캐릭터가 보이는 화면에서만 받는다 |
| 코드 | `apps/web/src/shared/guide/live2d-stage.ts` (싱글턴 무대), `GuideCharacter.tsx` (React 컴포넌트) |

- WebGL 캔버스는 **하나만** 만들고 로그인 화면 ↔ 투어 말풍선으로 옮겨 붙인다 (투어 단계마다 모델을 다시 읽지 않음, WebGL 컨텍스트 수 제한 회피).
- 원본 `model3.json` 은 수정하지 않는다. 읽은 뒤 메모리에서 모션 그룹만 `Idle`(haru_g_idle) / `Gesture`(m01~m26) 로 나눈다.
- 표정 파일이 없는 샘플이라 `expression` 이 `normal` 이 아니면 바뀔 때 **몸짓 모션 하나를 무작위** 재생한다. 캐릭터를 클릭해도 몸짓.
  - 특정 단계에 특정 모션(인사·안내 손짓 등)을 고정하려면 [Live2D Viewer Online](https://guansss.github.io/live2d-viewer-web/) 에서 m01~m26 을 확인한 뒤 번호를 정하면 된다 (아직 확인 안 함).
- 전신(`full`, 세로 160px 이상 기본) / 상반신(`bust`) 두 가지 구도. 상반신은 모델 위쪽 45% 를 보여 준다.
- `prefers-reduced-motion` 이면 시선 추적·몸짓을 끈다 (대기 모션만).
- 모델 파일이 없거나 WebGL·CDN 이 막히면 같은 크기의 "하루" 이름 배지로 대신한다 — 화면은 깨지지 않는다.

## 라이선스

- 『無償提供マテリアルの使用許諾契約書』(Live2D 오리지널 캐릭터) 동의 후 사용. **개인·소규모 사업자는 상업 이용 가능, 중·대규모 사업자는 비공개 테스트 용도만.** 자세한 조건: https://www.live2d.com/download/sample-data/
- 로그인 화면 아래에 `Live2D 샘플 모델 「하루」 © Live2D Inc.` 표기.
- **재배포 조건을 확인하기 전까지 모델 파일은 git 에 넣지 않는다** (`.gitignore`: `apps/web/public/live2d/`).
- Cubism Core 는 Live2D Proprietary Software License, 렌더러에 들어 있는 Cubism Framework 는 Live2D Open Software License 를 따른다.

## 새 PC·서버에 설치

1. https://www.live2d.com/download/sample-data/ 에서 하루(접수원 버전) 를 약관 동의 후 받는다 (`haru_greeter_ja.zip`).
2. zip 의 `runtime/` **안쪽** 내용을 아래로 복사한다.
   - 로컬: `apps/web/public/live2d/haru/`
   - 운영 서버: 배포 디렉터리의 `live2d/haru/` (compose 가 웹 컨테이너 `/usr/share/nginx/html/live2d` 에 읽기 전용으로 붙인다)
3. 확인: 브라우저에서 `/live2d/haru/haru_greeter_t05.model3.json` 이 열리면 된다.

`.cmo3`·`.can3`·`.psd` (편집용 원본) 는 웹에 필요 없으니 넣지 않는다.
