import { describe, expect, it } from 'vitest';
import {
  assetDisposalTotal,
  kindFor,
  templateFor,
  type PostingEvent,
} from '@/server/domain/posting-templates';
import { LedgerError } from '@/server/domain/ledger';

/**
 * 固定资产处置的分录模板。纯函数，不连库——DB 层的端到端用例在
 * tests/actions/fixed-assets-disposal.test.ts。
 */

const ASSET = 'account-asset';
const ACCUM = 'account-accum';
const BANK = 'account-bank';
const GAIN = 'account-gain';
const LOSS = 'account-loss';

function disposal(costMinor: bigint, accumulatedMinor: bigint, proceedsMinor: bigint): PostingEvent {
  const amounts = { costMinor, accumulatedMinor, proceedsMinor };
  return {
    type: 'asset-disposal',
    assetAccountId: ASSET,
    accumAccountId: ACCUM,
    proceedsAccountId: proceedsMinor > 0n ? BANK : null,
    gainAccountId: GAIN,
    lossAccountId: LOSS,
    ...amounts,
    amountMinor: assetDisposalTotal(amounts),
  };
}

describe('asset-disposal template', () => {
  it('scrap with partial depreciation: the book value is a loss', () => {
    expect(templateFor(disposal(120000n, 60000n, 0n))).toEqual([
      { accountId: ACCUM, direction: 'debit', amountMinor: 60000n },
      { accountId: LOSS, direction: 'debit', amountMinor: 60000n },
      { accountId: ASSET, direction: 'credit', amountMinor: 120000n },
    ]);
  });

  it('sale above book value: gain on the credit side', () => {
    expect(templateFor(disposal(120000n, 30000n, 100000n))).toEqual([
      { accountId: ACCUM, direction: 'debit', amountMinor: 30000n },
      { accountId: BANK, direction: 'debit', amountMinor: 100000n },
      { accountId: ASSET, direction: 'credit', amountMinor: 120000n },
      { accountId: GAIN, direction: 'credit', amountMinor: 10000n },
    ]);
  });

  it('sale below book value with no depreciation: no accumulated line', () => {
    expect(templateFor(disposal(120000n, 0n, 50000n))).toEqual([
      { accountId: BANK, direction: 'debit', amountMinor: 50000n },
      { accountId: LOSS, direction: 'debit', amountMinor: 70000n },
      { accountId: ASSET, direction: 'credit', amountMinor: 120000n },
    ]);
  });

  it('sale exactly at book value: neither gain nor loss', () => {
    expect(templateFor(disposal(120000n, 30000n, 90000n))).toEqual([
      { accountId: ACCUM, direction: 'debit', amountMinor: 30000n },
      { accountId: BANK, direction: 'debit', amountMinor: 90000n },
      { accountId: ASSET, direction: 'credit', amountMinor: 120000n },
    ]);
  });

  it('always balances and the header equals the debit side', () => {
    for (const [cost, accum, proceeds] of [
      [120000n, 0n, 0n],
      [120000n, 120000n, 0n],
      [120000n, 120000n, 5000n],
      [99999n, 33333n, 12345n],
    ] as const) {
      const event = disposal(cost, accum, proceeds);
      const lines = templateFor(event);
      const dr = lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amountMinor, 0n);
      const cr = lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amountMinor, 0n);
      expect(dr).toBe(cr);
      expect(dr).toBe(event.amountMinor);
      expect(lines.every((l) => l.amountMinor > 0n)).toBe(true);
    }
  });

  it('lands as a journal entry', () => {
    expect(kindFor(disposal(120000n, 0n, 0n))).toBe('journal');
  });

  it('refuses proceeds without a receiving account', () => {
    const event = { ...disposal(120000n, 0n, 1000n), proceedsAccountId: null } as PostingEvent;
    expect(() => templateFor(event)).toThrow(LedgerError);
  });

  it('refuses a header that does not match the debit side', () => {
    const event = { ...disposal(120000n, 0n, 0n), amountMinor: 1n } as PostingEvent;
    expect(() => templateFor(event)).toThrow(/debit side/);
  });

  it('refuses accumulated depreciation above cost', () => {
    expect(() => templateFor(disposal(100n, 200n, 0n))).toThrow(LedgerError);
  });
});
