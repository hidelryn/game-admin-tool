import { describe, expect, it } from 'vitest';
import type { CurrencyInfo } from '@game-admin/shared';
import { validateRows } from '../src/features/currencies/bulk-file';
import { parseDelimited } from '../src/shared/file/table-file';

const CURRENCIES: CurrencyInfo[] = [
  {
    code: 'GOLD',
    name: '골드',
    isPaid: false,
    maxBalance: 999_999_999,
    grantLimitPerRequest: 1_000_000,
  },
  {
    code: 'GEM',
    name: '유료 젬',
    isPaid: true,
    maxBalance: 9_999_999,
    grantLimitPerRequest: 10_000,
  },
];

describe('CSV 읽기', () => {
  it('따옴표 안의 쉼표·줄바꿈·"" 와 BOM 을 처리한다', () => {
    const rows = parseDelimited('﻿회원ID,사유\r\nU1,"점검, 보상"\r\nU2,"두 줄\n사유 ""인용"""\r\n');
    expect(rows).toEqual([
      ['회원ID', '사유'],
      ['U1', '점검, 보상'],
      ['U2', '두 줄\n사유 "인용"'],
    ]);
  });

  it('엑셀에서 복사한 탭 구분도 읽는다', () => {
    expect(parseDelimited('U1\tGOLD\t10\r\n')).toEqual([['U1', 'GOLD', '10']]);
  });
});

describe('대량 지급 파일 검증', () => {
  it('머리글이 있으면 열 순서가 달라도 이름으로 찾는다, 재화는 코드·이름 모두', () => {
    const r = validateRows(
      [
        ['사유', '수량', '재화', '회원ID'],
        ['점검 보상 지급', '1,000', '골드', 'U1'],
        ['점검 보상 지급', 5, 'gem', 'U1'],
      ],
      CURRENCIES,
    );
    expect(r.hasHeader).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.entries).toEqual([
      { publicId: 'U1', currencyCode: 'GOLD', amount: 1000, reason: '점검 보상 지급' },
      { publicId: 'U1', currencyCode: 'GEM', amount: 5, reason: '점검 보상 지급' },
    ]);
    expect(r.userCount).toBe(1);
    expect(r.totals).toEqual([
      { currencyCode: 'GOLD', amount: 1000 },
      { currencyCode: 'GEM', amount: 5 },
    ]);
  });

  it('행마다 이유를 붙여 거부하고, 정상 행만 지급 대상', () => {
    const r = validateRows(
      [
        ['U1', 'GOLD', 10, '정상 지급 사유'],
        ['', 'GOLD', 10, '정상 지급 사유'],
        ['U 2', 'GOLD', 10, '정상 지급 사유'],
        ['U3', 'SILVER', 10, '정상 지급 사유'],
        ['U4', 'GOLD', 'abc', '정상 지급 사유'],
        ['U5', 'GOLD', 1.5, '정상 지급 사유'],
        ['U6', 'GEM', 10_001, '정상 지급 사유'],
        ['U7', 'GOLD', 10, '짧음'],
        ['U1', 'GOLD', 20, '같은 조합 중복'],
      ],
      CURRENCIES,
    );
    expect(r.hasHeader).toBe(false);
    expect(r.rows.map((x) => x.error ?? 'OK')).toEqual([
      'OK',
      '회원 ID 없음',
      '회원 ID 형식 오류',
      '알 수 없는 재화: SILVER',
      '수량이 숫자가 아님',
      '수량은 1 이상 정수',
      '유료 젬 1인당 상한(10,000) 초과',
      '사유는 5자 이상',
      '중복 (1행과 같은 회원·재화)',
    ]);
    expect(r.entries).toHaveLength(1);
    expect(r.errorCount).toBe(8);
  });

  it('빈 줄은 건너뛰고, 1,000명을 넘으면 파일 전체를 거부', () => {
    const many = Array.from({ length: 1001 }, (_, i) => [`U${i}`, 'GOLD', 1, '대량 지급 사유']);
    const r = validateRows([['', '', '', ''], ...many], CURRENCIES);
    expect(r.rows).toHaveLength(1001);
    expect(r.fatal).toContain('1,000명');
  });
});
