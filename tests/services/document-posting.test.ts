import { describe, expect, it } from 'vitest';
import { LedgerError } from '@/server/domain/ledger';
import { MoneyError } from '@/server/domain/money';
import { templateFor } from '@/server/domain/posting-templates';
import {
  billPostingEvent,
  documentClientUuid,
  invoicePostingEvent,
  lineAmountMinor,
  mulDivHalfUp,
  parseTaxRateBps,
  resolveDocumentCurrency,
  taxMinorFor,
  withDocumentNumberRetry,
} from '@/server/services/document-posting';

/**
 * 这个文件一条数据库查询都不发。
 *
 * 单据过账里真正容易错、也真正错过的那几处——税率解析、行金额舍入、
 * 幂等键的派生、净额税额怎么落到借贷两侧——全都是纯函数，不需要一家公司、
 * 一套科目和一次网络往返才能量。0021 迁移尚未执行，依赖新列的集成测试今天
 * 跑不了；这一份现在就能跑，而它盖住的正是那几个 bug。
 */

describe('mulDivHalfUp - 舍入口径', () => {
  /**
   * 半个最小单位必须进位，不能截断。
   *
   * 这一条是整个单据模块的地基：server/domain/exchange-rate.ts 的
   * convertToBaseMinor 用的就是 half-up，而每一行发票金额最终都要经过它
   * 换算成本位币。行金额自己按截断算、换算按 half-up 算，就是同一笔钱在
   * 同一条路径上被两种规则处理，差额稳定偏向一侧。
   */
  it('rounds a half up rather than truncating toward zero', () => {
    // 7.5 -> 8，而 BigInt 除法会给 7
    expect(mulDivHalfUp(75n, 1n, 10n)).toBe(8n);
    expect(75n / 10n).toBe(7n);
  });

  it('leaves exact quotients alone and rounds below-half down', () => {
    expect(mulDivHalfUp(70n, 1n, 10n)).toBe(7n);
    expect(mulDivHalfUp(74n, 1n, 10n)).toBe(7n);
    expect(mulDivHalfUp(76n, 1n, 10n)).toBe(8n);
  });

  it('refuses a zero divisor and negative inputs instead of returning a number', () => {
    expect(() => mulDivHalfUp(1n, 1n, 0n)).toThrow(LedgerError);
    expect(() => mulDivHalfUp(-1n, 1n, 10n)).toThrow(LedgerError);
  });
});

describe('lineAmountMinor - 单价 × 数量', () => {
  /**
   * 原来的写法是 (unitBig * qtyBig) / 10000n，向零截断。
   * 单价 3.33、数量 1.5 的精确值是 4.995，应当是 5.00；截断给的是 4.99。
   * 每一行少一分，一张十行的发票就与客户对不上账。
   */
  it('rounds the line extension half up', () => {
    expect(lineAmountMinor(333n, '1.5')).toBe(500n);
    // 截断的旧算法会给 499
    expect((333n * 15000n) / 10000n).toBe(499n);
  });

  it('handles whole quantities exactly', () => {
    expect(lineAmountMinor(12345n, '1')).toBe(12345n);
    expect(lineAmountMinor(12345n, '3')).toBe(37035n);
  });

  it('keeps all four decimal places of a numeric(12,4) quantity', () => {
    // 1.0001 × 10000 分 = 10001 分
    expect(lineAmountMinor(1000000n, '1.0001')).toBe(1000100n);
  });

  /**
   * 数量原来是手搓解析的：`(qtyParts[1] ?? '').padEnd(4,'0').slice(0,4)`
   * 会把 '2.00005' 的第五位小数悄悄截掉，而 'abc' 会让 BigInt 抛一句
   * 看不懂的 SyntaxError。现在交给 parseDecimalToMinor，两种都报得清楚。
   */
  it('rejects a quantity with more precision than the column can hold', () => {
    expect(() => lineAmountMinor(100n, '2.00005')).toThrow(MoneyError);
  });

  it('rejects a non-numeric quantity instead of silently reading a prefix', () => {
    expect(() => lineAmountMinor(100n, 'abc')).toThrow(MoneyError);
    expect(() => lineAmountMinor(100n, '2abc')).toThrow(MoneyError);
  });

  it('rejects a zero or negative quantity', () => {
    expect(() => lineAmountMinor(100n, '0')).toThrow(LedgerError);
    expect(() => lineAmountMinor(100n, '-1')).toThrow(MoneyError);
  });
});

describe('parseTaxRateBps - 税率解析', () => {
  /**
   * 原来是 `parseFloat(input) * 100` 再 Math.round。浮点那条路上的中间值
   * 确实是错的（8.2 * 100 = 819.9999999999999），只是两位小数的百分数
   * 每一个都被 Math.round 修了回来——今天还没算错过一个税率，但那是运气，
   * 不是设计。这一条钉住的是「整条路径上不出现浮点」。
   */
  it('parses a two-decimal percentage into basis points without floating point', () => {
    expect(parseTaxRateBps('6')).toBe(600);
    expect(parseTaxRateBps('6.05')).toBe(605);
    expect(parseTaxRateBps('8.2')).toBe(820);
    expect(parseTaxRateBps('0.5')).toBe(50);
    expect(parseTaxRateBps('10')).toBe(1000);
    // 旧路径上那个中间值本身是错的
    expect(parseFloat('8.2') * 100).not.toBe(820);
  });

  it('treats an absent or empty rate as no tax', () => {
    expect(parseTaxRateBps(undefined)).toBe(0);
    expect(parseTaxRateBps('')).toBe(0);
    expect(parseTaxRateBps('  ')).toBe(0);
    expect(parseTaxRateBps('0')).toBe(0);
  });

  /**
   * `|| 0` 把非法输入静默变成 0 税率。parseFloat 是前缀解析：
   * '6,05'（用逗号的地区写法）得到 6，'1e2' 得到 100，'abc' 得到 NaN
   * 然后被 || 0 变成 0——一张本该含 6% SST 的发票就这样静默地变成免税
   * 发票开了出去，用户看不到任何提示。
   */
  it('refuses garbage instead of silently falling back to a zero rate', () => {
    expect(() => parseTaxRateBps('abc')).toThrow(MoneyError);
    expect(() => parseTaxRateBps('6%')).toThrow(MoneyError);
    expect(() => parseTaxRateBps('1e2')).toThrow(MoneyError);
    // parseFloat 在这三个输入上分别给 NaN / 6 / 100，全都不会报错
    expect(parseFloat('abc') || 0).toBe(0);
    expect(parseFloat('6%')).toBe(6);
  });

  /**
   * 逗号在这里有两种可能的意思，两种都不能默认：用逗号做小数点的 '6,5'
   * 是 6.5%，而 parseDecimalToMinor 会把它当千分位删掉、得到 65%。
   * 旧写法则把它当成 6%。三个不同的数，没有一个能靠猜。
   */
  it('refuses a comma in a tax rate instead of guessing what it means', () => {
    expect(() => parseTaxRateBps('6,5')).toThrow(/comma/i);
    expect(() => parseTaxRateBps('6,05')).toThrow(/comma/i);
    // 旧写法会把 6,5% 当成 6%
    expect(parseFloat('6,5')).toBe(6);
  });

  it('refuses precision finer than one basis point', () => {
    expect(() => parseTaxRateBps('6.005')).toThrow(MoneyError);
  });

  /**
   * 上限 100%：tax_rate_bps 是 int4，没有上界时一个手滑的 '1000000000'
   * 会在数据库层面溢出，而超过 100% 的销售税率在实务上一律是把 6.00
   * 敲成了 600。
   */
  it('refuses a rate above 100% as a typo', () => {
    expect(() => parseTaxRateBps('600')).toThrow(/typo/i);
    expect(parseTaxRateBps('100')).toBe(10000);
  });
});

describe('taxMinorFor - 税额', () => {
  /**
   * 原来是 (subTotalMinor * BigInt(taxRateBps)) / 10000n，同样向零截断。
   * 净额 1.25、税率 6% 的精确值是 0.075，应当进位成 0.08；截断给 0.07。
   * 税额算少一分的后果不止是账不平：交出去的销项税是错的。
   */
  it('rounds the tax half up', () => {
    expect(taxMinorFor(125n, 600)).toBe(8n);
    expect((125n * 600n) / 10000n).toBe(7n);
  });

  it('returns zero for a zero rate', () => {
    expect(taxMinorFor(999999n, 0)).toBe(0n);
  });

  it('computes a plain 6% on a round subtotal exactly', () => {
    expect(taxMinorFor(100000n, 600)).toBe(6000n);
  });

  it('refuses a rate that is not a whole number of basis points', () => {
    expect(() => taxMinorFor(100n, 6.5)).toThrow(LedgerError);
    expect(() => taxMinorFor(100n, -1)).toThrow(LedgerError);
  });
});

describe('resolveDocumentCurrency - 缺省币种', () => {
  /**
   * 0008 给 invoices/bills 的 currency 写的是 default 'USD'，而
   * organizations.timezone 的默认值是 Asia/Kuala_Lumpur——这是给马来西亚
   * 商户做的产品。0021 删掉了那个默认值，缺省从此由应用侧给，而唯一正确的
   * 缺省是本位币：本位币记账不需要汇率，USD 记账需要，而发票表单上根本
   * 没有填汇率的地方。
   */
  it('falls back to the company base currency, not USD', () => {
    expect(resolveDocumentCurrency(undefined, 'MYR')).toBe('MYR');
    expect(resolveDocumentCurrency('', 'MYR')).toBe('MYR');
    expect(resolveDocumentCurrency('   ', 'SGD')).toBe('SGD');
  });

  it('keeps an explicitly chosen currency', () => {
    expect(resolveDocumentCurrency('USD', 'MYR')).toBe('USD');
  });

  it('normalises case so the 0021 check constraint sees ^[A-Z]{3}$', () => {
    expect(resolveDocumentCurrency('myr', 'MYR')).toBe('MYR');
    expect(resolveDocumentCurrency(' usd ', 'MYR')).toBe('USD');
  });

  it('refuses a code that is not three letters', () => {
    expect(() => resolveDocumentCurrency('RM', 'MYR')).toThrow(MoneyError);
    expect(() => resolveDocumentCurrency('RINGGIT', 'MYR')).toThrow(MoneyError);
  });
});

describe('documentClientUuid - 幂等键', () => {
  const invoiceId = '6d0f7b2a-1c33-4d55-9a71-0b1d2e3f4a55';

  /**
   * postJournal 的幂等完全建立在 clientUuid 上。单据这条路径上没有像交易
   * 表单那样由客户端生成的 uuid——用户点的是「开具」按钮，一次双击、一次
   * 断网重发、一次 Server Action 重试都会带着同样的单据 id 再来一次。
   * 随机生成等于关掉幂等：同一张发票记两笔应收，两笔各自配平，触发器与
   * 不变量校验没有一道看得出问题。
   */
  it('derives the same uuid from the same document every time', () => {
    const first = documentClientUuid({ kind: 'invoice', id: invoiceId });
    const second = documentClientUuid({ kind: 'invoice', id: invoiceId });
    expect(second).toBe(first);
  });

  it('derives a different uuid for a different document of the same kind', () => {
    const other = '6d0f7b2a-1c33-4d55-9a71-0b1d2e3f4a56';
    expect(documentClientUuid({ kind: 'invoice', id: other })).not.toBe(
      documentClientUuid({ kind: 'invoice', id: invoiceId }),
    );
  });

  /** 单据种类进了派生名，所以发票与账单即使 id 相同也不会撞同一个 clientUuid。 */
  it('derives a different uuid for the same id under a different document kind', () => {
    expect(documentClientUuid({ kind: 'bill', id: invoiceId })).not.toBe(
      documentClientUuid({ kind: 'invoice', id: invoiceId }),
    );
  });

  /** transactions.client_uuid 是 uuid 列，形状不对连插都插不进去。 */
  it('produces a well-formed RFC 4122 version 5 uuid', () => {
    const value = documentClientUuid({ kind: 'invoice', id: invoiceId });
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

/**
 * 单号冲突的重试。
 *
 * 并发那一条在 tests/actions/*-posting.test.ts 里真的并发跑，量的是端到端
 * 行为；这一组量的是重试本身的判断——只认那一个约束名、只重试有限次。
 * 用假的错误对象而不是真撞一次数据库：撞不撞得上取决于两个事务的时序，
 * 而「23505 但换了个约束名时必须原样抛出去」这条根本没法靠运气量到。
 */
describe('withDocumentNumberRetry - 单号冲突重试', () => {
  /** postgres.js 把 Postgres 的 ErrorResponse 字段按 snake_case 挂在错误对象上。 */
  function pgError(code: string, constraintName: string): Error {
    return Object.assign(new Error('duplicate key value violates unique constraint'), {
      code,
      constraint_name: constraintName,
    });
  }

  it('retries the whole attempt when the document number collides', async () => {
    let calls = 0;
    const result = await withDocumentNumberRetry('invoices_org_number', async () => {
      calls += 1;
      if (calls < 3) throw pgError('23505', 'invoices_org_number');
      return 'INV-00003';
    });

    expect(result).toBe('INV-00003');
    expect(calls).toBe(3);
  });

  it('does not retry when the attempt succeeds', async () => {
    let calls = 0;
    await withDocumentNumberRetry('bills_org_number', async () => {
      calls += 1;
      return 'BILL-00001';
    });
    expect(calls).toBe(1);
  });

  /**
   * 这一条是这组测试存在的主要理由。transactions 上的
   * (organization_id, client_uuid) 也是 23505——那是幂等键真的撞了，
   * 重试只会把一个该被看见的问题变成一次沉默的重放。
   */
  it('rethrows a unique violation on a different constraint without retrying', async () => {
    let calls = 0;
    await expect(
      withDocumentNumberRetry('invoices_org_number', async () => {
        calls += 1;
        throw pgError('23505', 'transactions_organization_id_client_uuid_key');
      }),
    ).rejects.toThrow(/duplicate key/);

    expect(calls).toBe(1);
  });

  it('rethrows any error that is not a unique violation without retrying', async () => {
    let calls = 0;
    await expect(
      withDocumentNumberRetry('invoices_org_number', async () => {
        calls += 1;
        throw pgError('42703', 'invoices_org_number'); // undefined_column
      }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
  });

  /** 持续冲突时不能无限重试，最后一次的真实错误要原样抛给调用方。 */
  it('gives up after a bounded number of attempts and surfaces the real error', async () => {
    let calls = 0;
    await expect(
      withDocumentNumberRetry('invoices_org_number', async () => {
        calls += 1;
        throw pgError('23505', 'invoices_org_number');
      }),
    ).rejects.toThrow(/duplicate key/);

    expect(calls).toBe(5);
  });
});

/**
 * 事件构造 + templateFor 的组合，就是「一张发票最终长成什么样的分录」。
 * 方向本身在 server/domain/posting-templates.ts 里定义（不是这个文件的
 * 职责），这里量的是单据上那三个数有没有装到正确的字段上——把 netMinor
 * 与 amountMinor 写反的分录照样配平，没有任何一道校验看得出来。
 */
describe('invoicePostingEvent - 开销售发票的分录形状', () => {
  const accounts = {
    receivableAccountId: 'ar',
    revenueAccountId: 'sales',
    taxAccountId: 'output-tax',
  };

  it('debits receivable for the gross and credits revenue plus output tax', () => {
    const event = invoicePostingEvent(accounts, {
      subtotalMinor: 10000n,
      taxMinor: 600n,
      totalMinor: 10600n,
    });

    expect(templateFor(event)).toEqual([
      { accountId: 'ar', direction: 'debit', amountMinor: 10600n },
      { accountId: 'sales', direction: 'credit', amountMinor: 10000n },
      { accountId: 'output-tax', direction: 'credit', amountMinor: 600n },
    ]);
  });

  /** 没配税的公司：不出税行。journal_lines.amount_minor 有 > 0 的 CHECK。 */
  it('emits two lines when there is no tax', () => {
    const event = invoicePostingEvent(
      { ...accounts, taxAccountId: null },
      { subtotalMinor: 10000n, taxMinor: 0n, totalMinor: 10000n },
    );

    expect(templateFor(event)).toEqual([
      { accountId: 'ar', direction: 'debit', amountMinor: 10000n },
      { accountId: 'sales', direction: 'credit', amountMinor: 10000n },
    ]);
  });

  it('refuses a total that is not net plus tax', () => {
    const event = invoicePostingEvent(accounts, {
      subtotalMinor: 10000n,
      taxMinor: 600n,
      totalMinor: 10000n, // 忘了加税
    });
    expect(() => templateFor(event)).toThrow(/does not equal net/);
  });
});

describe('billPostingEvent - 收到供应商账单的分录形状', () => {
  const accounts = {
    payableAccountId: 'ap',
    expenseAccountId: 'purchases',
    taxAccountId: 'input-tax',
  };

  /**
   * 进项税挂的是 tax-receivable（资产），不是 tax-payable（负债）——
   * 两者挂反了，报表上「应缴税款 = 销项 - 进项」会变成「销项 + 进项」，
   * 而分录照样配平。科目代码的正确性由 resolveBillAccounts 保证，
   * 这里量的是方向：税额与费用同在借方。
   */
  it('debits expense and input tax, credits payable for the gross', () => {
    const event = billPostingEvent(accounts, {
      subtotalMinor: 10000n,
      taxMinor: 600n,
      totalMinor: 10600n,
    });

    expect(templateFor(event)).toEqual([
      { accountId: 'purchases', direction: 'debit', amountMinor: 10000n },
      { accountId: 'input-tax', direction: 'debit', amountMinor: 600n },
      { accountId: 'ap', direction: 'credit', amountMinor: 10600n },
    ]);
  });

  it('emits two lines when there is no tax', () => {
    const event = billPostingEvent(
      { ...accounts, taxAccountId: null },
      { subtotalMinor: 10000n, taxMinor: 0n, totalMinor: 10000n },
    );

    expect(templateFor(event)).toEqual([
      { accountId: 'purchases', direction: 'debit', amountMinor: 10000n },
      { accountId: 'ap', direction: 'credit', amountMinor: 10000n },
    ]);
  });

  /** 有税额却没有税科目，是 resolveBillAccounts 被绕过去了的信号。 */
  it('refuses a tax amount with no tax account', () => {
    const event = billPostingEvent(
      { ...accounts, taxAccountId: null },
      { subtotalMinor: 10000n, taxMinor: 600n, totalMinor: 10600n },
    );
    expect(() => templateFor(event)).toThrow(/no tax account is configured/);
  });
});
