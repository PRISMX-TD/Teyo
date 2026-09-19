import { describe, expect, it } from 'vitest';
import { kindFor, templateFor, type PostingEvent } from '@/server/domain/posting-templates';
import { buildCheckedLines, LedgerError } from '@/server/domain/ledger';
import { RATE_SCALE } from '@/server/domain/exchange-rate';

/**
 * 单据事件的分录模板。
 *
 * 这些用例断言的是「哪一侧是借、哪一侧是贷、金额怎么拆」——也就是
 * posting-templates.ts 作为全项目唯一记账方向定义所承担的那件事。方向
 * 写反是本项目出过的那类 bug 的形状（分录照样配平、照样没人看得出来），
 * 所以这里逐个模板钉死具体的 accountId 与 direction，而不是只断言「配平」。
 */

const AR = 'account-receivable';
const AP = 'account-payable';
const REVENUE = 'account-revenue';
const EXPENSE = 'account-expense';
const OUTPUT_TAX = 'account-output-tax';
const INPUT_TAX = 'account-input-tax';
const BANK = 'account-bank';

/** 把分录压成 `方向:科目:金额` 的字符串，断言读起来就是一张丁字账。 */
function shape(event: PostingEvent): string[] {
  return templateFor(event).map(
    (line) => `${line.direction}:${line.accountId}:${line.amountMinor}`,
  );
}

describe('invoice template', () => {
  it('splits into receivable debit, revenue credit and output tax credit', () => {
    expect(
      shape({
        type: 'invoice',
        receivableAccountId: AR,
        revenueAccountId: REVENUE,
        taxAccountId: OUTPUT_TAX,
        netMinor: 10_000n,
        taxMinor: 600n,
        amountMinor: 10_600n,
      }),
    ).toEqual([
      `debit:${AR}:10600`,
      `credit:${REVENUE}:10000`,
      `credit:${OUTPUT_TAX}:600`,
    ]);
  });

  it('omits the tax line entirely when there is no tax', () => {
    // journal_lines.amount_minor 有 > 0 的 CHECK：一条金额为零的税行会被
    // 数据库直接拒绝，而用户看到的是一句读不懂的约束报错。
    expect(
      shape({
        type: 'invoice',
        receivableAccountId: AR,
        revenueAccountId: REVENUE,
        taxAccountId: null,
        netMinor: 10_000n,
        taxMinor: 0n,
        amountMinor: 10_000n,
      }),
    ).toEqual([`debit:${AR}:10000`, `credit:${REVENUE}:10000`]);
  });
});

describe('bill template', () => {
  it('splits into expense debit, input tax debit and payable credit', () => {
    expect(
      shape({
        type: 'bill',
        payableAccountId: AP,
        expenseAccountId: EXPENSE,
        taxAccountId: INPUT_TAX,
        netMinor: 5_000n,
        taxMinor: 300n,
        amountMinor: 5_300n,
      }),
    ).toEqual([
      `debit:${EXPENSE}:5000`,
      `debit:${INPUT_TAX}:300`,
      `credit:${AP}:5300`,
    ]);
  });
});

describe('credit note template', () => {
  it('is the exact reverse of the invoice template', () => {
    const args = {
      receivableAccountId: AR,
      revenueAccountId: REVENUE,
      taxAccountId: OUTPUT_TAX,
      netMinor: 10_000n,
      taxMinor: 600n,
      amountMinor: 10_600n,
    };

    const invoice = templateFor({ type: 'invoice', ...args });
    const creditNote = templateFor({ type: 'credit-note', ...args });

    // 同一组科目与金额，每一行的方向恰好相反。这条断言比逐行写死更能
    // 说明「贷项通知单是发票的反向」——如果哪天有人改了其中一个模板，
    // 这里会红。
    const flip = (direction: string) => (direction === 'debit' ? 'credit' : 'debit');
    const invoiceFlipped = invoice
      .map((line) => `${flip(line.direction)}:${line.accountId}:${line.amountMinor}`)
      .sort();

    expect(
      creditNote.map((line) => `${line.direction}:${line.accountId}:${line.amountMinor}`).sort(),
    ).toEqual(invoiceFlipped);
  });
});

describe('settlement templates', () => {
  it('records a customer receipt as bank debit against receivable credit', () => {
    expect(
      shape({
        type: 'customer-receipt',
        moneyAccountId: BANK,
        receivableAccountId: AR,
        amountMinor: 10_600n,
      }),
    ).toEqual([`debit:${BANK}:10600`, `credit:${AR}:10600`]);
  });

  it('records a supplier payment as payable debit against bank credit', () => {
    expect(
      shape({
        type: 'supplier-payment',
        moneyAccountId: BANK,
        payableAccountId: AP,
        amountMinor: 5_300n,
      }),
    ).toEqual([`debit:${AP}:5300`, `credit:${BANK}:5300`]);
  });
});

describe('tax split validation', () => {
  const base = {
    type: 'invoice' as const,
    receivableAccountId: AR,
    revenueAccountId: REVENUE,
    taxAccountId: OUTPUT_TAX,
  };

  it('refuses a total that does not equal net plus tax', () => {
    // 三个数不自洽时分录仍然配平（净额与税额自成一组），但交易表头金额
    // 与单据总额对不上——而数据库的配平触发器只看分录、看不到表头。
    expect(() =>
      templateFor({ ...base, netMinor: 10_000n, taxMinor: 600n, amountMinor: 10_000n }),
    ).toThrow(LedgerError);
  });

  it('refuses negative components', () => {
    expect(() =>
      templateFor({ ...base, netMinor: 11_000n, taxMinor: -400n, amountMinor: 10_600n }),
    ).toThrow(LedgerError);
  });

  it('refuses a tax amount with no tax account configured', () => {
    expect(() =>
      templateFor({
        ...base,
        taxAccountId: null,
        netMinor: 10_000n,
        taxMinor: 600n,
        amountMinor: 10_600n,
      }),
    ).toThrow(LedgerError);
  });

  it('refuses a document that totals zero', () => {
    expect(() =>
      templateFor({ ...base, netMinor: 0n, taxMinor: 0n, amountMinor: 0n }),
    ).toThrow(LedgerError);
  });

  it('still refuses a settlement whose two sides are the same account', () => {
    expect(() =>
      templateFor({
        type: 'customer-receipt',
        moneyAccountId: BANK,
        receivableAccountId: BANK,
        amountMinor: 100n,
      }),
    ).toThrow(LedgerError);
  });
});

describe('kindFor', () => {
  it('keeps the four user-facing actions as their own kind', () => {
    expect(kindFor({ type: 'income', moneyAccountId: BANK, revenueAccountId: REVENUE, amountMinor: 1n })).toBe('income');
    expect(kindFor({ type: 'expense', moneyAccountId: BANK, expenseAccountId: EXPENSE, amountMinor: 1n })).toBe('expense');
    expect(kindFor({ type: 'transfer', fromAccountId: BANK, toAccountId: AR, amountMinor: 1n })).toBe('transfer');
    expect(kindFor({ type: 'journal', debitAccountId: BANK, creditAccountId: AR, amountMinor: 1n })).toBe('journal');
  });

  it('maps every document event to journal', () => {
    // 'journal' 是 transactions_category_matches_kind 约束下唯一不要求
    // category_id 的非 transfer kind（见 0014 迁移）。单据的对方科目由单据
    // 自己指定，套一个分类上去等于凭空编一个用户没选过的归类。
    const documents: PostingEvent[] = [
      { type: 'invoice', receivableAccountId: AR, revenueAccountId: REVENUE, taxAccountId: null, netMinor: 1n, taxMinor: 0n, amountMinor: 1n },
      { type: 'bill', payableAccountId: AP, expenseAccountId: EXPENSE, taxAccountId: null, netMinor: 1n, taxMinor: 0n, amountMinor: 1n },
      { type: 'customer-receipt', moneyAccountId: BANK, receivableAccountId: AR, amountMinor: 1n },
      { type: 'supplier-payment', moneyAccountId: BANK, payableAccountId: AP, amountMinor: 1n },
      { type: 'credit-note', receivableAccountId: AR, revenueAccountId: REVENUE, taxAccountId: null, netMinor: 1n, taxMinor: 0n, amountMinor: 1n },
    ];

    for (const event of documents) {
      expect(kindFor(event)).toBe('journal');
    }
  });
});

describe('three-line documents survive the full line pipeline', () => {
  /**
   * 这一组是整个扩展最该被盯住的地方。
   *
   * ledger.ts 的 buildLines 会逐行独立换算本位币金额，两边合计因逐行舍入
   * 差出来的残差被吸收进短边最大的那一行——也就是故意让那一行不等于自己
   * 的 convertToBaseMinor。assertLineInvariants（I3）正是照着「吸收之后」
   * 的样子写的。它那段注释里预言过：「今天碰不到，只是因为四个模板都恰好
   * 出两行同额分录，残差恒为 0；第一笔三行外币事件（阶段 4 的发票、资产
   * 处置）会在自己的边界上撞出一条假的 I3 错误，而不是记账成功。」
   *
   * 三行发票就是那第一笔。这里用一个会真的产生残差的汇率喂进去，断言它
   * 记账成功而不是抛错。
   */
  it('posts a three-line foreign-currency invoice without tripping I3', () => {
    const lines = buildCheckedLines(
      templateFor({
        type: 'invoice',
        receivableAccountId: AR,
        revenueAccountId: REVENUE,
        taxAccountId: OUTPUT_TAX,
        netMinor: 3_333n,
        taxMinor: 200n,
        amountMinor: 3_533n,
      }),
      {
        currency: 'USD',
        baseCurrency: 'MYR',
        // 4.21837 —— 一个会让 3333 与 200 各自舍入后合计对不上总额的汇率。
        scaledRate: 421_837_000n,
        rateSource: 'auto',
      },
    );

    const sum = (direction: 'debit' | 'credit') =>
      lines
        .filter((line) => line.direction === direction)
        .reduce((total, line) => total + line.baseAmountMinor, 0n);

    expect(sum('debit')).toBe(sum('credit'));
    expect(lines).toHaveLength(3);
  });

  it('posts a three-line document in a zero-decimal currency', () => {
    // JPY 的 exponent 是 0。convertToBaseMinor 要同时处理两端小数位不同
    // 与逐行舍入，三行是它第一次真的被考到。
    const lines = buildCheckedLines(
      templateFor({
        type: 'bill',
        payableAccountId: AP,
        expenseAccountId: EXPENSE,
        taxAccountId: INPUT_TAX,
        netMinor: 10_001n,
        taxMinor: 1_000n,
        amountMinor: 11_001n,
      }),
      {
        currency: 'JPY',
        baseCurrency: 'MYR',
        scaledRate: 2_871_000n, // 0.02871
        rateSource: 'auto',
      },
    );

    const sum = (direction: 'debit' | 'credit') =>
      lines
        .filter((line) => line.direction === direction)
        .reduce((total, line) => total + line.baseAmountMinor, 0n);

    expect(sum('debit')).toBe(sum('credit'));
  });

  it('still refuses an automatic rate of exactly 1 on a foreign-currency document', () => {
    // I4。三行事件不该给这条不变量开后门。
    expect(() =>
      buildCheckedLines(
        templateFor({
          type: 'invoice',
          receivableAccountId: AR,
          revenueAccountId: REVENUE,
          taxAccountId: OUTPUT_TAX,
          netMinor: 1_000n,
          taxMinor: 60n,
          amountMinor: 1_060n,
        }),
        {
          currency: 'USD',
          baseCurrency: 'MYR',
          scaledRate: RATE_SCALE,
          rateSource: 'auto',
        },
      ),
    ).toThrow(LedgerError);
  });
});
