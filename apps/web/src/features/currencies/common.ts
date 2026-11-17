import { useQuery } from '@tanstack/react-query';
import type { CurrencyInfo } from '@game-admin/shared';
import { api } from '../../shared/api/client';

export const SOURCE_LABEL: Record<string, string> = {
  ADMIN: '운영자',
  MAIL: '우편',
  GAME: '게임',
  PURCHASE: '결제',
};

export const CHANNEL_LABEL: Record<string, string> = {
  WEB: '웹',
  MCP: 'MCP',
  SYSTEM: '시스템',
};

/** 재화 목록은 거의 바뀌지 않으므로 5분 캐시 */
export function useCurrencies() {
  return useQuery({
    queryKey: ['currencies'],
    queryFn: async () => (await api.get<CurrencyInfo[]>('/currencies')).data,
    staleTime: 5 * 60_000,
  });
}

/** 코드 → "이름 (코드)" */
export function currencyLabel(list: CurrencyInfo[] | undefined, code: string) {
  const c = list?.find((x) => x.code === code);
  return c ? `${c.name} (${c.code})` : code;
}
