import { useMemo } from 'react';
import { Flex, Tour, Typography, type TourProps } from 'antd';
import { Permission } from '@game-admin/shared';
import { useAuth } from '../auth/AuthProvider';
import { GUIDE_NAME, GuideCharacter, type GuideExpression } from './GuideCharacter';

interface Stop {
  /** 메뉴 키(경로). 없으면 화면 가운데 */
  key?: string;
  /** 투어 버튼처럼 메뉴가 아닌 요소 */
  selector?: string;
  permission?: Permission;
  title: string;
  text: string;
  expression?: GuideExpression;
}

/** 투어 순서 — 권한이 없는 메뉴는 건너뛴다 */
const STOPS: Stop[] = [
  {
    title: `안녕하세요, ${GUIDE_NAME}예요!`,
    text: '게임 운영 백오피스를 한 바퀴 안내해 드릴게요. 언제든 위의 "둘러보기"로 다시 볼 수 있어요.',
    expression: 'smile',
  },
  {
    key: '/dashboard',
    permission: Permission.DASHBOARD_READ,
    title: '대시보드',
    text: '오늘 접속자(DAU)·신규 가입·재화 발행/소모를 한눈에 봐요. 게임이 점검 중인지도 여기서 보여요.',
  },
  {
    key: '/users',
    permission: Permission.USER_READ,
    title: '회원 관리',
    text: '회원을 찾아 활동 이력·재화·우편함을 보고, 정지·해제할 수 있어요. 개인정보는 기본으로 가려져 있어요.',
  },
  {
    key: '/currencies',
    permission: Permission.CURRENCY_READ,
    title: '재화 관리',
    text: '지급·회수와 원장(모든 변동 기록)을 다뤄요. 회수나 큰 금액은 미리보기로 한 번 확인하고, 100명 이상 대량 지급은 빨간 경고가 한 번 더 떠요.',
    expression: 'alert',
  },
  {
    key: '/mails',
    permission: Permission.MAIL_READ,
    title: '우편',
    text: '회원 우편함으로 보상을 보내요. 누가 받았는지 수령 현황도 볼 수 있어요.',
  },
  {
    key: '/rankings',
    permission: Permission.RANKING_READ,
    title: '랭킹',
    text: '아레나·월드아레나 순위를 실시간으로 봐요. 점수가 같으면 먼저 기록한 회원이 위예요. 시즌이 끝나면 최종 순위가 저장돼요.',
  },
  {
    key: '/schedules',
    permission: Permission.SCHEDULE_READ,
    title: '스케줄',
    text: '랭킹 시즌과 이벤트 기간, 게임 안 팝업·배너를 달력에서 관리해요.',
  },
  {
    key: '/live-notices',
    permission: Permission.NOTICE_READ,
    title: '점검·공지',
    text: '점검을 걸면 게임 접속이 막히고 접속 중인 유저는 끊겨요. 긴급 점검은 꼭 확인을 한 번 더 받아요. 공지와 로비 한 줄 공지도 여기서요.',
    expression: 'alert',
  },
  {
    key: '/audit-logs',
    permission: Permission.AUDIT_READ,
    title: '운영 로그',
    text: '누가 언제 무엇을, 웹에서 했는지 AI(MCP)로 했는지까지 전부 남아요.',
  },
  {
    key: '/me/api-tokens',
    permission: Permission.TOKEN_MANAGE_OWN,
    title: 'API 토큰 · AI 연결',
    text: 'AI 클라이언트(MCP)를 연결할 토큰을 발급해요. AI도 같은 권한·확인 절차를 거치고, 대규모 작업은 웹에서만 실행돼요. (체험 계정은 발급할 수 없어요)',
  },
  {
    selector: '[data-tour="tour-button"]',
    title: '안내 끝!',
    text: '이제 자유롭게 눌러 보세요. 체험 데이터는 매일 새벽 처음 상태로 돌아가니 마음껏 해 보셔도 괜찮아요.',
    expression: 'wink',
  },
];

type Step = NonNullable<TourProps['steps']>[number];

const menuTarget = (key: string) => () =>
  // antd Menu 항목은 data-menu-id="...-<키>" 를 가진다
  document.querySelector<HTMLElement>(`[data-menu-id$="-${key}"]`);

export function GuideTour({ open, onClose }: { open: boolean; onClose(): void }) {
  const { can } = useAuth();
  const steps = useMemo<TourProps['steps']>(() => {
    const list = STOPS.filter((s) => !s.permission || can(s.permission));
    return list.map((s, i): Step => ({
      title: s.title,
      description: (
        <Flex gap={12} align="center">
          <GuideCharacter expression={s.expression ?? 'normal'} size={110} />
          <Typography.Paragraph style={{ margin: 0 }}>{s.text}</Typography.Paragraph>
        </Flex>
      ),
      placement: s.key ? 'right' : 'bottom',
      // 요소를 못 찾으면(메뉴 접힘 등) 화면 가운데에 띄운다
      target: (s.key
        ? menuTarget(s.key)
        : s.selector
          ? () => document.querySelector<HTMLElement>(s.selector!)
          : null) as Step['target'],
      nextButtonProps: { children: i === list.length - 1 ? '끝내기' : '다음' },
      prevButtonProps: { children: '이전' },
    }));
  }, [can]);
  return <Tour open={open} onClose={onClose} onFinish={onClose} steps={steps} />;
}

/** 체험 계정의 첫 로그인에 투어를 자동으로 한 번 (브라우저 저장소를 못 쓰면 매번 묻지 않고 건너뜀) */
const seenKey = (adminId: number) => `ga:tour-seen:${adminId}`;
export function shouldAutoStartTour(adminId: number): boolean {
  try {
    return localStorage.getItem(seenKey(adminId)) === null;
  } catch {
    return false;
  }
}
export function markTourSeen(adminId: number) {
  try {
    localStorage.setItem(seenKey(adminId), '1');
  } catch {
    /* 저장소를 못 쓰면 무시 */
  }
}
