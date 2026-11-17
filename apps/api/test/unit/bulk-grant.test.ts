import { describe, expect, it } from 'vitest';
import { bulkGrantRequestSchema, type BulkGrant } from '@game-admin/shared';
import { bulkTotals, summarizeBulkGrant } from '../../src/modules/currencies/currency.service.js';

const reason = '이벤트 보상 지급';

describe('대량 지급 요청 정규화', () => {
  it('행별 재화·수량은 그대로, 재화 코드는 대문자로', () => {
    const v = bulkGrantRequestSchema.parse({
      reason,
      entries: [
        { publicId: 'U1', currencyCode: 'gold', amount: 10 },
        { publicId: 'U1', currencyCode: 'GEM', amount: 2 }, // 같은 회원, 다른 재화
      ],
    });
    expect(v).toEqual({
      entries: [
        { publicId: 'U1', currencyCode: 'GOLD', amount: 10, reason },
        { publicId: 'U1', currencyCode: 'GEM', amount: 2, reason },
      ],
    });
  });

  it('행에 비운 재화·사유는 요청의 값으로 채우고, 행에 있으면 행의 값을 쓴다', () => {
    const v = bulkGrantRequestSchema.parse({
      reason,
      currencyCode: 'gold',
      entries: [
        { publicId: 'U1', amount: 5 },
        { publicId: 'U2', currencyCode: 'GEM', amount: 1, reason: '시즌 1위 보상' },
      ],
    });
    expect(v.entries).toEqual([
      { publicId: 'U1', currencyCode: 'GOLD', amount: 5, reason },
      { publicId: 'U2', currencyCode: 'GEM', amount: 1, reason: '시즌 1위 보상' },
    ]);
  });

  it('행마다 사유가 있으면 요청 사유 없이도 된다 (CSV·엑셀 업로드 형태)', () => {
    const v = bulkGrantRequestSchema.parse({
      entries: [{ publicId: 'U1', currencyCode: 'GOLD', amount: 1, reason: '버그 보상 지급' }],
    });
    expect(v.entries[0]!.reason).toBe('버그 보상 지급');
  });

  it('전원 같은 지급(publicIds + amount)도 entries 로 바뀐다 — 이전 승인 payload 호환', () => {
    const v = bulkGrantRequestSchema.parse({
      reason,
      currencyCode: 'GOLD',
      publicIds: ['U1', 'U2'],
      amount: 7,
    });
    expect(v.entries).toEqual([
      { publicId: 'U1', currencyCode: 'GOLD', amount: 7, reason },
      { publicId: 'U2', currencyCode: 'GOLD', amount: 7, reason },
    ]);
  });

  it.each([
    [
      '두 형태를 함께',
      {
        currencyCode: 'GOLD',
        entries: [{ publicId: 'U1', amount: 1 }],
        publicIds: ['U1'],
        amount: 1,
      },
    ],
    ['아무것도 없음', { currencyCode: 'GOLD' }],
    ['publicIds 만', { currencyCode: 'GOLD', publicIds: ['U1'] }],
    ['전원 같은 지급인데 재화 없음', { publicIds: ['U1'], amount: 1 }],
    ['행에도 기본값에도 재화 없음', { entries: [{ publicId: 'U1', amount: 1 }] }],
    [
      '같은 회원·재화 중복',
      {
        entries: [
          { publicId: 'U1', currencyCode: 'GOLD', amount: 1 },
          { publicId: 'U1', currencyCode: 'gold', amount: 2 },
        ],
      },
    ],
    [
      '기본 재화로 채운 뒤 중복',
      {
        currencyCode: 'GOLD',
        entries: [
          { publicId: 'U1', amount: 1 },
          { publicId: 'U1', currencyCode: 'GOLD', amount: 2 },
        ],
      },
    ],
    ['중복 회원 (publicIds)', { currencyCode: 'GOLD', publicIds: ['U1', 'U1'], amount: 1 }],
    ['수량 0', { entries: [{ publicId: 'U1', currencyCode: 'GOLD', amount: 0 }] }],
    ['소수 수량', { entries: [{ publicId: 'U1', currencyCode: 'GOLD', amount: 1.5 }] }],
  ])('거부: %s', (_, body) => {
    expect(bulkGrantRequestSchema.safeParse({ reason, ...body }).success).toBe(false);
  });

  it.each([
    [
      '행에도 요청에도 사유 없음',
      { entries: [{ publicId: 'U1', currencyCode: 'GOLD', amount: 1 }] },
    ],
    [
      '행 사유가 너무 짧음',
      { entries: [{ publicId: 'U1', currencyCode: 'GOLD', amount: 1, reason: '보상' }] },
    ],
    ['전원 같은 지급인데 사유 없음', { currencyCode: 'GOLD', publicIds: ['U1'], amount: 1 }],
  ])('거부(사유): %s', (_, body) => {
    expect(bulkGrantRequestSchema.safeParse(body).success).toBe(false);
  });
});

const g = (entries: [string, string, number][]): BulkGrant => ({
  entries: entries.map(([publicId, currencyCode, amount]) => ({
    publicId,
    currencyCode,
    amount,
    reason: '테스트 사유',
  })),
});

describe('대량 지급 승인 요약', () => {
  it('재화 1종·같은 수량', () => {
    expect(
      summarizeBulkGrant(
        g([
          ['a', 'GEM', 10],
          ['b', 'GEM', 10],
        ]),
      ),
    ).toBe('GEM 10개 × 2명 지급');
  });

  it('재화 1종·다른 수량', () => {
    expect(
      summarizeBulkGrant(
        g([
          ['a', 'GOLD', 1000],
          ['b', 'GOLD', 200],
          ['c', 'GOLD', 30],
        ]),
      ),
    ).toBe('GOLD 총 1,230개 · 3명 지급 (1인 30~1,000개)');
  });

  it('여러 재화: 인원·건수·재화별 합계 (3종 넘으면 "외 n종")', () => {
    const v = g([
      ['a', 'GOLD', 1000],
      ['a', 'GEM', 5],
      ['b', 'GOLD', 200],
      ['b', 'FREE_GEM', 10],
      ['c', 'STAMINA', 50],
    ]);
    expect(summarizeBulkGrant(v)).toBe(
      '3명 · 5건 지급 (GOLD 1,200개, GEM 5개, FREE_GEM 10개 외 1종)',
    );
    expect(bulkTotals(v.entries)).toEqual([
      { currencyCode: 'GOLD', amount: 1200 },
      { currencyCode: 'GEM', amount: 5 },
      { currencyCode: 'FREE_GEM', amount: 10 },
      { currencyCode: 'STAMINA', amount: 50 },
    ]);
  });
});
