// 对账单解析器。三类缺陷各有用例：
//   1. 浮点算钱（parseFloat / toFixed(2)）；
//   2. 日期 DD/MM 与 MM/DD 靠「首段是否 > 12」猜；
//   3. 解析不出来的东西被静默变成 0 或被跳过。
//
// 第 3 类在这个应用里最贵：对账的全部意义就是核对，一笔编出来的 0 会让
// 「账面和银行对得上」变成一句假话。
import { describe, expect, it } from 'vitest';
import {
  BankImportError,
  parseCsvBuffer,
  parseOfxBuffer,
  parseQifBuffer,
  parseStatementAmountToMinor,
} from '@/server/services/bank_import_parser';

const buf = (text: string) => Buffer.from(text, 'utf-8');

/** 本位币是 MYR（两位小数）时的选项。 */
const myr = { exponent: 2 };
/** 本位币是 JPY（零位小数）时的选项。 */
const jpy = { exponent: 0 };

describe('parseStatementAmountToMinor', () => {
  it('reads the amounts a Malaysian bank actually exports', () => {
    // 'RM1,234.56' 是 Maybank / CIMB 的默认导出形状。上一版的
    // normalizeAmount 只剥 $€£¥ 和逗号，RM 的两个字母留在串里，
    // parseFloat('RM1234.56') 是 NaN，于是整笔金额变成 0。
    expect(parseStatementAmountToMinor('RM1,234.56', 2)).toBe(123456n);
    expect(parseStatementAmountToMinor('MYR 1,234.56', 2)).toBe(123456n);
    expect(parseStatementAmountToMinor('$1,234.56', 2)).toBe(123456n);
    expect(parseStatementAmountToMinor('1 234.56', 2)).toBe(123456n);
  });

  it('reads every way a statement writes a negative', () => {
    expect(parseStatementAmountToMinor('-123.45', 2)).toBe(-12345n);
    expect(parseStatementAmountToMinor('(123.45)', 2)).toBe(-12345n);
    expect(parseStatementAmountToMinor('123.45-', 2)).toBe(-12345n);
    // 负号夹在货币代码与数字之间——马来西亚的银行导出就是这个形状。
    // 只判串首是不是 '-' 的话，这个负号会跟着 'RM' 一起被当成装饰剥掉，
    // 一笔支出就变成了一笔收入。
    expect(parseStatementAmountToMinor('RM-1,200.50', 2)).toBe(-120050n);
    expect(parseStatementAmountToMinor('-RM1,200.50', 2)).toBe(-120050n);
    expect(parseStatementAmountToMinor('RM -1,200.50', 2)).toBe(-120050n);
    expect(parseStatementAmountToMinor('RM123.45 DR', 2)).toBe(-12345n);
    expect(parseStatementAmountToMinor('RM123.45 CR', 2)).toBe(12345n);
  });

  it('decides between a decimal comma and a thousands comma without guessing', () => {
    // 两种都在：靠后的那个是小数点。
    expect(parseStatementAmountToMinor('1.234,56', 2)).toBe(123456n);
    expect(parseStatementAmountToMinor('1,234.56', 2)).toBe(123456n);
    // 只有逗号：符合 1,234 这种分组形状就是千分位。
    expect(parseStatementAmountToMinor('1,234', 2)).toBe(123400n);
    // 不符合分组形状，就只可能是小数点。
    expect(parseStatementAmountToMinor('1234,56', 2)).toBe(123456n);
  });

  it('keeps every digit on an amount that would not survive a float', () => {
    // Number('99999999999999.99') 已经不是这个数了；再 .toFixed(2) 会得到
    // ...98。少的那一分钱在账上永远对不上，而且没有任何东西会报错。
    expect(parseStatementAmountToMinor('99999999999999.99', 2)).toBe(9999999999999999n);
  });

  it('refuses a fraction the company currency cannot hold', () => {
    // JPY 没有小数。上一版一律 .toFixed(2)，等于给每一笔日元凭空造出两位
    // 小数，再按 exponent 0 解析——结果是金额被放大一百倍或直接报错。
    expect(parseStatementAmountToMinor('1200', 0)).toBe(1200n);
    expect(() => parseStatementAmountToMinor('1200.50', 0)).toThrow(BankImportError);
  });

  it('refuses something that is not an amount instead of returning zero', () => {
    for (const junk of ['', '   ', 'n/a', 'abc', '--', '--1.00', '1-2', '2026-09-01']) {
      expect(() => parseStatementAmountToMinor(junk, 2), junk).toThrow(BankImportError);
    }
  });
});

describe('parseCsvBuffer - dates are never guessed', () => {
  const ambiguous = buf(
    ['Date,Description,Amount', '03/04/2026,Rent,-1200.00', '05/06/2026,Sales,900.00'].join('\n'),
  );

  it('blocks a file whose day/month order cannot be derived', () => {
    // 这正是旧启发式最危险的地方：它不会报错，它会挑一个。一份 2026 年
    // 3 月的对账单里每一行的首段都 <= 12，于是整月被读成「3 月 1 日到
    // 3 月 12 日各一笔」，其余全部错位，而界面上一个字都不会说。
    expect(() => parseCsvBuffer(ambiguous, myr)).toThrow(BankImportError);
    expect(() => parseCsvBuffer(ambiguous, myr)).toThrow(/day\/month|month\/day|3 April|4 March/i);
  });

  it('accepts the same file once the order is stated', () => {
    expect(parseCsvBuffer(ambiguous, { ...myr, dateFormat: 'dmy' }).map((r) => r.date)).toEqual([
      '2026-04-03',
      '2026-06-05',
    ]);
    expect(parseCsvBuffer(ambiguous, { ...myr, dateFormat: 'mdy' }).map((r) => r.date)).toEqual([
      '2026-03-04',
      '2026-05-06',
    ]);
  });

  it('derives the order from the file when the file actually settles it', () => {
    // 有一行的首段是 31，那一段只可能是「日」，整份文件就此确定——
    // 这是推导，不是猜：没有第二种读法。
    const settled = buf(
      ['Date,Description,Amount', '31/12/2026,Rent,-1200.00', '03/04/2026,Sales,900.00'].join('\n'),
    );
    expect(parseCsvBuffer(settled, myr).map((r) => r.date)).toEqual(['2026-12-31', '2026-04-03']);
  });

  it('needs no help at all for ISO and named-month dates', () => {
    const iso = buf(
      ['Date,Description,Amount', '2026-04-03,Rent,-1200.00', '01-Jan-2026,Sales,900.00'].join('\n'),
    );
    expect(parseCsvBuffer(iso, myr).map((r) => r.date)).toEqual(['2026-04-03', '2026-01-01']);
  });

  it('refuses a file that contains both orders', () => {
    const contradictory = buf(
      ['Date,Description,Amount', '31/12/2026,A,1.00', '12/31/2026,B,2.00'].join('\n'),
    );
    expect(() => parseCsvBuffer(contradictory, myr)).toThrow(/day-month and others as month-day/i);
  });
});

describe('parseCsvBuffer - amounts', () => {
  it('never turns an unreadable amount into zero', () => {
    const broken = buf(
      ['Date,Description,Amount', '2026-04-03,Rent,-1200.00', '2026-04-04,Sales,see attached'].join(
        '\n',
      ),
    );
    // 旧行为：第 2 行金额记成 0，导入报告「成功，2 笔」。
    expect(() => parseCsvBuffer(broken, myr)).toThrow(BankImportError);
    // 报错必须指得出是哪一行——用户在 Excel 里看到的行号是 3（表头占第 1 行）。
    expect(() => parseCsvBuffer(broken, myr)).toThrow(/Line 3/);
  });

  it('nets a debit and a credit column in BigInt', () => {
    const twoColumns = buf(
      [
        'Date,Narrative,Debit,Credit',
        '2026-04-03,Rent,99999999999999.99,',
        '2026-04-04,Sales,,99999999999999.99',
        '2026-04-05,Fee,10.00,2.50',
      ].join('\n'),
    );
    const rows = parseCsvBuffer(twoColumns, myr);
    // (credit - debit)，全程 BigInt。旧代码是
    // (parseFloat(credit) - parseFloat(debit)).toFixed(2)，这一行会差一分钱。
    expect(rows.map((r) => r.amountMinor)).toEqual([
      -9999999999999999n,
      9999999999999999n,
      -750n,
    ]);
  });

  it('treats an empty debit/credit cell as nothing, not as a broken row', () => {
    const rows = parseCsvBuffer(
      buf(['Date,Debit,Credit', '2026-04-03,,500.00'].join('\n')),
      myr,
    );
    expect(rows[0].amountMinor).toBe(50000n);
  });

  it('keeps skipping the rows that carry no date, because that is how totals rows are excluded', () => {
    const withFooter = buf(
      [
        'Date,Description,Amount',
        '2026-04-03,Rent,-1200.00',
        '',
        'TOTAL,,-1200.00',
        'This statement is issued without signature,,',
      ].join('\n'),
    );
    const rows = parseCsvBuffer(withFooter, myr);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountMinor).toBe(-120000n);
  });

  it('refuses a file with no amount column at all', () => {
    expect(() => parseCsvBuffer(buf('Date,Description\n2026-04-03,Rent'), myr)).toThrow(
      /no amount column/i,
    );
  });

  it('refuses a file with no date column at all', () => {
    expect(() => parseCsvBuffer(buf('Description,Amount\nRent,-1200.00'), myr)).toThrow(
      /no date column/i,
    );
  });
});

describe('parseOfxBuffer', () => {
  const ofx = `
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260403120000<TRNAMT>-1200.00<NAME>Rent</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260404<TRNAMT>900.50<MEMO>Sales</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it('reads OFX dates and amounts exactly', () => {
    expect(parseOfxBuffer(buf(ofx), myr)).toEqual([
      expect.objectContaining({ date: '2026-04-03', amountMinor: -120000n, description: 'Rent' }),
      expect.objectContaining({ date: '2026-04-04', amountMinor: 90050n, description: 'Sales' }),
    ]);
  });

  it('refuses an entry whose TRNAMT is missing instead of recording it as zero', () => {
    const missing = `<OFX><STMTTRN><DTPOSTED>20260403<NAME>Rent</STMTTRN></OFX>`;
    expect(() => parseOfxBuffer(buf(missing), myr)).toThrow(BankImportError);
    expect(() => parseOfxBuffer(buf(missing), myr)).toThrow(/2026-04-03/);
  });

  it('refuses two decimals when the company keeps a zero-decimal currency', () => {
    expect(() => parseOfxBuffer(buf(ofx), jpy)).toThrow(BankImportError);
  });
});

describe('parseQifBuffer', () => {
  it('does not assume the US month-first order just because QIF says so', () => {
    // QIF 规范里日期是 M/D/YY，但导出这种文件的软件遍地都是。规范说什么
    // 不等于这份文件是什么——推导不出来就报错，不按规范默认。
    const ambiguous = buf(['!Type:Bank', 'D03/04/2026', 'T-1200.00', 'PRent', '^'].join('\n'));
    expect(() => parseQifBuffer(ambiguous, myr)).toThrow(BankImportError);
    expect(parseQifBuffer(ambiguous, { ...myr, dateFormat: 'dmy' })[0].date).toBe('2026-04-03');
  });

  it('reads an unambiguous QIF entry', () => {
    const qif = buf(
      ['!Type:Bank', 'D31/12/2026', 'T-1,234.56', 'PLandlord', 'MDecember rent', '^'].join('\n'),
    );
    expect(parseQifBuffer(qif, myr)).toEqual([
      expect.objectContaining({
        date: '2026-12-31',
        amountMinor: -123456n,
        description: 'Landlord',
      }),
    ]);
  });

  it('refuses an entry whose amount cannot be read', () => {
    const broken = buf(['!Type:Bank', 'D2026-04-03', 'Tpending', 'PRent', '^'].join('\n'));
    expect(() => parseQifBuffer(broken, myr)).toThrow(BankImportError);
  });
});
