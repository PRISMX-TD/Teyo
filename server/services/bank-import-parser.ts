import { MoneyError, parseDecimalToMinor } from '@/server/domain/money';

/**
 * 对账单解析失败。
 *
 * 这个类存在的理由，就是这个模块过去没有它：解析不出来的东西被安静地
 * 变成 0 或者被跳过，用户看到「导入成功，123 笔」，而其中若干笔的金额
 * 是编出来的。银行对账单是用来核对账目的，一笔编出来的 0 比一次失败的
 * 导入危险得多——它会让「账面和银行对得上」这句话变成假的。
 *
 * 文案一律指明是第几行、原文是什么，好让用户直接去看那一行。
 */
export class BankImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankImportError';
  }
}

/**
 * 对账单里日期的写法。
 *
 * 'dmy' = 31/12/2026，'mdy' = 12/31/2026，'iso' = 2026-12-31。
 *
 * 这个参数必须存在，因为「01/02/2026」是 1 月 2 日还是 2 月 1 日，文件本身
 * 没有答案。之前的代码用「第一段大于 12 就是日在前，否则当成月在前」来猜，
 * 而这条启发式恰恰在最常见的情况下失败：一家马来西亚商户整月的对账单里，
 * 每一天的日期都不超过 12 的月份（比如 2026 年 3 月），首段永远 ≤ 12，于是
 * 整份文件被按 MM/DD 读成 3 月 1 日至 3 月 12 日各一笔，其余全部错位——
 * 报表上整整一个月的支出跑到了别的月份，而且没有任何提示。
 *
 * 本仓库的第一原则是「能不猜就不猜；不能推导时明确阻塞，绝不静默猜测」。
 * 所以这里的规则是：能从文件自身**推导**出来就用推导的结果（某一行出现了
 * 大于 12 的首段，那整份文件必然是日在前），推导不出来就报错要求指定，
 * 永远不猜。
 */
export type StatementDateFormat = 'iso' | 'dmy' | 'mdy';

export type ParsedTransaction = {
  /** YYYY-MM-DD。 */
  date: string;
  description: string;
  /**
   * 已经是 minor units 的 bigint，不再是十进制字符串。
   *
   * 解析必须在这里一次做完：上一版返回字符串，调用方再解析一次，中间那次
   * `parseFloat(...).toFixed(2)` 让每一笔金额在变成 bigint 之前先过了一轮
   * IEEE754，而且 `.toFixed(2)` 对 JPY/VND/KRW 这些零小数币种是错的。
   */
  amountMinor: bigint;
  rawRow: Record<string, string>;
};

export type ParseOptions = {
  /** 本位币的小数位数，来自 server/domain/money.ts 的 currencyExponent。 */
  exponent: number;
  /** 用户明确指定的日期写法。不指定时由文件内容推导，推导不出就报错。 */
  dateFormat?: StatementDateFormat;
};

// ---------------------------------------------------------------------------
// 金额
// ---------------------------------------------------------------------------

/**
 * 把对账单上的一个金额字段解析成 minor units。
 *
 * 全程字符串与 BigInt，一次浮点都不碰——理由见 server/domain/money.ts：
 * 这个应用里金额的唯一表示是 bigint minor units，而 parseFloat 会在解析的
 * 第一步就把 0.1 + 0.2 那类误差引进来，之后再怎么四舍五入都追不回来。
 *
 * 处理的写法（都是真实对账单里出现过的）：
 *   RM1,234.56   马来西亚银行的默认导出，上一版把它整个解析成 0
 *   $1,234.56 / €1.234,56 / 1 234,56
 *   (123.45)     会计惯例的负数
 *   123.45-      某些主机系统把负号放在后面
 *   1,234.56 CR / 1,234.56 DR   贷/借标记
 *
 * 千分位与小数点的判定是确定性的，不是猜：
 *   同时出现 '.' 与 ','  —— 靠后的那个是小数点，另一个是千分位。
 *   只出现 ','          —— 如果整体符合 1,234,567 这种分组形状，它就是
 *                          千分位；否则它只可能是小数点（欧陆写法）。
 *   只出现 '.'          —— 小数点。'1.234' 这种在欧陆写法里是千分位，但
 *                          那要求它后面跟三位而本位币只有两位小数，
 *                          parseDecimalToMinor 会因为「小数位数超了」报错，
 *                          而不是把 1234 静默读成 1.23。
 */
export function parseStatementAmountToMinor(raw: string, exponent: number): bigint {
  const original = raw ?? '';
  let text = original.trim();

  if (text === '') {
    throw new BankImportError('This row has no amount.');
  }

  let negative = false;

  // 会计写法：(123.45) 是负数。
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // CR/DR 标记。CR 在银行对账单上是「进账」，DR 是「出账」——从公司的角度
  // 看，进账为正、出账为负，与 TRNAMT 的符号约定一致。
  const crdr = /\b(CR|DR)\b\s*$/i.exec(text);
  if (crdr) {
    if (crdr[1].toUpperCase() === 'DR') negative = true;
    text = text.slice(0, crdr.index).trim();
  }

  // 以第一个数字为界，把串切成「前缀」和「数字部分」。
  //
  // 不能只看 text 开不开头是 '-'：马来西亚的银行导出写的是 'RM-1,200.50'，
  // 负号夹在货币代码和数字中间。只判开头的话，这个负号会跟着货币代码一起
  // 被当成装饰剥掉，一笔支出就变成了一笔收入——账面照样配平，报表上却多了
  // 一笔两倍金额的误差，而且没有任何东西会报错。
  const firstDigit = text.search(/\d/);
  if (firstDigit === -1) {
    throw new BankImportError(`"${original.trim()}" is not an amount.`);
  }

  const prefix = text.slice(0, firstDigit);
  let body = text.slice(firstDigit).trim();

  if ((prefix.match(/[-+]/g) ?? []).length > 1) {
    throw new BankImportError(`"${original.trim()}" is not an amount.`);
  }
  if (prefix.includes('-')) negative = !negative;

  // 后置负号是某些主机系统的写法：'123.45-'。
  if (body.endsWith('-')) {
    negative = !negative;
    body = body.slice(0, -1).trim();
  }

  // 数字中间还留着减号的，不是金额（'1-2'、'2026-09-01' 被填错了列）。
  if (body.includes('-')) {
    throw new BankImportError(`"${original.trim()}" is not an amount.`);
  }

  // 剥掉货币符号与代码：RM、MYR、$、€、£、¥、S$、不换行空格等等。
  // 只保留数字与两种分隔符，剩下的一律当作装饰。
  const stripped = body.replace(/[^0-9.,]/g, '');
  if (stripped === '') {
    throw new BankImportError(`"${original.trim()}" is not an amount.`);
  }

  const lastDot = stripped.lastIndexOf('.');
  const lastComma = stripped.lastIndexOf(',');

  let normalised: string;
  if (lastDot !== -1 && lastComma !== -1) {
    // 两种都在：靠后的是小数点。
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const groupSep = decimalSep === '.' ? ',' : '.';
    normalised = stripped.split(groupSep).join('').replace(decimalSep, '.');
  } else if (lastComma !== -1) {
    // 只有逗号。符合千分位分组形状就是千分位，否则只能是小数点。
    normalised = /^\d{1,3}(,\d{3})+$/.test(stripped)
      ? stripped.split(',').join('')
      : stripped.replace(/,/g, '.');
  } else {
    normalised = stripped;
  }

  try {
    const minor = parseDecimalToMinor(normalised, exponent);
    return negative ? -minor : minor;
  } catch (error) {
    if (error instanceof MoneyError) {
      // 把 money.ts 那句面向开发者的话换成指得出问题的话。最常见的触发原因是
      // 零小数币种（JPY/VND/KRW）的对账单里带了两位小数。
      throw new BankImportError(
        `"${original.trim()}" is not an amount this company's currency can hold ` +
          `(it allows ${exponent} decimal place${exponent === 1 ? '' : 's'}).`,
      );
    }
    throw error;
  }
}

/** 借/贷两列中的一格：空格就是 0，其余照常解析。 */
function parseColumnAmountToMinor(raw: string, exponent: number): bigint {
  return raw.trim() === '' ? 0n : parseStatementAmountToMinor(raw, exponent);
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** 某年某月有多少天。全程 UTC，避免本地时区把月末挪走。 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 两位年份的世纪。对账单不会来自 1950 年以前，也不会来自 2049 年以后。 */
function expandYear(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.length <= 2) return n < 50 ? 2000 + n : 1900 + n;
  return n;
}

type DateCell =
  /** 写法本身就无歧义（ISO、带月份名），已经能定下来。 */
  | { kind: 'fixed'; iso: string }
  /** 两个数字谁是日谁是月，要由整份文件一起决定。 */
  | { kind: 'numeric'; first: number; second: number; year: number }
  /** 不像日期——表头之外的说明行、合计行、空行。 */
  | { kind: 'unknown' };

function classifyDateCell(value: string): DateCell {
  const cleaned = (value ?? '').trim();
  if (cleaned === '') return { kind: 'unknown' };

  // ISO：2026-12-31 或 2026/12/31。四位年份在最前面，没有歧义。
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(cleaned);
  if (iso) {
    const result = toIso(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10));
    return result ? { kind: 'fixed', iso: result } : { kind: 'unknown' };
  }

  // 带月份名：01-Jan-2025、1 Jan 2025、Jan 1, 2025。月份是名字就没有歧义。
  const dayFirstNamed = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})$/.exec(cleaned);
  if (dayFirstNamed) {
    const month = MONTH_NAMES[dayFirstNamed[2].slice(0, 3).toLowerCase()];
    if (month) {
      const result = toIso(expandYear(dayFirstNamed[3]), month, parseInt(dayFirstNamed[1], 10));
      if (result) return { kind: 'fixed', iso: result };
    }
    return { kind: 'unknown' };
  }
  const monthFirstNamed = /^([A-Za-z]{3,})[-/\s](\d{1,2}),?[-/\s](\d{2,4})$/.exec(cleaned);
  if (monthFirstNamed) {
    const month = MONTH_NAMES[monthFirstNamed[1].slice(0, 3).toLowerCase()];
    if (month) {
      const result = toIso(expandYear(monthFirstNamed[3]), month, parseInt(monthFirstNamed[2], 10));
      if (result) return { kind: 'fixed', iso: result };
    }
    return { kind: 'unknown' };
  }

  // 纯数字三段：31/12/2026、12-31-26、31.12.2026。年份在最后。
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(cleaned);
  if (numeric) {
    return {
      kind: 'numeric',
      first: parseInt(numeric[1], 10),
      second: parseInt(numeric[2], 10),
      year: expandYear(numeric[3]),
    };
  }

  return { kind: 'unknown' };
}

const AMBIGUOUS_DATE_MESSAGE =
  'The dates in this file are written as numbers only (like 03/04/2026), so there is no way ' +
  'to tell whether that means 3 April or 4 March. Re-export the statement with ' +
  'year-month-day dates, or tell us which order your bank uses.';

/**
 * 从整份文件的日期单元格推导出「日在前还是月在前」。
 *
 * 只有两种结局：定下来，或者报错。**没有第三种**。
 *
 *   用户明说了     —— 照办。
 *   某行首段 > 12  —— 那一段只可能是「日」，整份文件就是 dmy。
 *   某行次段 > 12  —— 那一段只可能是「日」，整份文件就是 mdy。
 *   两种证据都有   —— 这份文件自相矛盾（多半是两家银行的导出拼在了一起），
 *                     报错，让用户自己看。
 *   一条证据都没有 —— 报错要求指定。这里正是上一版开始猜的地方。
 *
 * 全是 fixed（ISO 或带月份名）时返回 null：根本没有需要决定的事。
 */
function resolveNumericOrder(
  cells: DateCell[],
  requested: StatementDateFormat | undefined,
): 'dmy' | 'mdy' | null {
  const numeric = cells.filter((cell): cell is Extract<DateCell, { kind: 'numeric' }> =>
    cell.kind === 'numeric',
  );
  if (numeric.length === 0) return null;

  if (requested === 'dmy' || requested === 'mdy') return requested;
  if (requested === 'iso') {
    // 用户说这份文件是 ISO，可它里面有非 ISO 的日期。与其按某种顺序读下去，
    // 不如说清楚不一致在哪。
    throw new BankImportError(
      'This file was imported as year-month-day, but some rows use a different date format. ' +
        'Check the file and try again.',
    );
  }

  const dayFirst = numeric.some((cell) => cell.first > 12);
  const monthFirst = numeric.some((cell) => cell.second > 12);

  if (dayFirst && monthFirst) {
    throw new BankImportError(
      'Some dates in this file read as day-month and others as month-day. ' +
        'Split the file by bank and import each part on its own.',
    );
  }
  if (dayFirst) return 'dmy';
  if (monthFirst) return 'mdy';

  throw new BankImportError(AMBIGUOUS_DATE_MESSAGE);
}

function resolveCell(cell: DateCell, order: 'dmy' | 'mdy' | null): string | null {
  if (cell.kind === 'fixed') return cell.iso;
  if (cell.kind === 'unknown') return null;
  if (order === null) return null;

  const day = order === 'dmy' ? cell.first : cell.second;
  const month = order === 'dmy' ? cell.second : cell.first;
  return toIso(cell.year, month, day);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * 解析 CSV。
 *
 * 两趟：先把所有日期单元格分类、定下日期顺序，再逐行组装。一趟做不到——
 * 「这份文件是日在前还是月在前」是整份文件的属性，第 1 行读不出来，要等到
 * 出现某一行的首段大于 12 才能确定（也可能整份文件都确定不了，那就报错）。
 *
 * 日期解析不出来的行会被跳过，这是有意的：对账单末尾常有合计行、余额行、
 * 声明行，它们没有日期，跳过是唯一能把它们挡在外面的办法。但日期正常、
 * 金额解析不出来的行会**报错**——那是一笔真实交易，读不出来就必须让用户
 * 知道，而不是记成 0。
 */
export function parseCsvBuffer(buffer: Buffer, options: ParseOptions): ParsedTransaction[] {
  const text = buffer.toString('utf-8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const dataLines = lines.slice(1).filter((line) => line.trim() !== '');

  const dateIdx = findHeaderIndex(headers, /date/i);
  const descIdx = findHeaderIndex(headers, /description|memo|payee|name|narrative|particulars/i);
  const amountIdx = findHeaderIndex(headers, /amount|sum|value/i);

  // 没有单一金额列时退回借/贷两列。
  const debitIdx = amountIdx === -1 ? findHeaderIndex(headers, /debit|withdrawal|payment/i) : -1;
  const creditIdx = amountIdx === -1 ? findHeaderIndex(headers, /credit|deposit|income/i) : -1;

  if (dateIdx === -1) {
    throw new BankImportError(
      'This file has no date column, so there is no way to tell when each entry happened.',
    );
  }
  if (amountIdx === -1 && (debitIdx === -1 || creditIdx === -1)) {
    throw new BankImportError(
      'This file has no amount column. It needs either an "Amount" column, ' +
        'or a "Debit" and a "Credit" column.',
    );
  }

  const rows = dataLines.map((line) => parseCsvLine(line));

  // 第一趟：日期。
  const cells = rows.map((fields) =>
    classifyDateCell(fields.length > dateIdx ? fields[dateIdx] : ''),
  );
  const order = resolveNumericOrder(cells, options.dateFormat);

  // 第二趟：组装。
  const results: ParsedTransaction[] = [];

  rows.forEach((fields, index) => {
    const date = resolveCell(cells[index], order);
    if (!date) return;

    const description = descIdx !== -1 && descIdx < fields.length ? fields[descIdx] : '';
    // 文件第 1 行是表头，数据从第 2 行起——报错里给的必须是用户在
    // Excel 里看到的那个行号。
    const lineNumber = index + 2;

    let amountMinor: bigint;
    try {
      if (amountIdx !== -1) {
        amountMinor = parseStatementAmountToMinor(
          amountIdx < fields.length ? fields[amountIdx] : '',
          options.exponent,
        );
      } else {
        const debit = parseColumnAmountToMinor(
          debitIdx < fields.length ? fields[debitIdx] : '',
          options.exponent,
        );
        const credit = parseColumnAmountToMinor(
          creditIdx < fields.length ? fields[creditIdx] : '',
          options.exponent,
        );
        // 全程 BigInt。上一版是 parseFloat(credit) - parseFloat(debit) 再
        // .toFixed(2)，两次浮点外加一个对零小数币种错误的固定位数。
        amountMinor = credit - debit;
      }
    } catch (error) {
      if (error instanceof BankImportError) {
        throw new BankImportError(`Line ${lineNumber}: ${error.message}`);
      }
      throw error;
    }

    const rawRow: Record<string, string> = {};
    headers.forEach((header, i) => {
      rawRow[header] = i < fields.length ? fields[i] : '';
    });

    results.push({ date, description, amountMinor, rawRow });
  });

  return results;
}

// ---------------------------------------------------------------------------
// OFX / QFX
// ---------------------------------------------------------------------------

/**
 * 解析 OFX/QFX 的 STMTTRN 块。
 *
 * OFX 的日期是 YYYYMMDD[HHMMSS]，本来就没有歧义，所以这里不需要 dateFormat。
 */
export function parseOfxBuffer(buffer: Buffer, options: ParseOptions): ParsedTransaction[] {
  const text = buffer.toString('utf-8');
  const results: ParsedTransaction[] = [];

  const txnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = txnRegex.exec(text)) !== null) {
    index += 1;
    const block = match[1];

    const dtposted = extractOfxTag(block, 'DTPOSTED');
    const trnamt = extractOfxTag(block, 'TRNAMT');
    const name = extractOfxTag(block, 'NAME');
    const memo = extractOfxTag(block, 'MEMO');

    const date = parseOfxDate(dtposted);
    if (!date) continue;

    let amountMinor: bigint;
    try {
      // TRNAMT 是必填字段。缺了或者读不出来就是这份文件坏了，
      // 静默记成 0 会在账上留下一笔看不出来的假交易。
      amountMinor = parseStatementAmountToMinor(trnamt, options.exponent);
    } catch (error) {
      if (error instanceof BankImportError) {
        throw new BankImportError(`Entry ${index} (${date}): ${error.message}`);
      }
      throw error;
    }

    results.push({
      date,
      description: name || memo || '',
      amountMinor,
      rawRow: { DTPOSTED: dtposted, TRNAMT: trnamt, NAME: name, MEMO: memo },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// QIF
// ---------------------------------------------------------------------------

/**
 * 解析 QIF 的 !Type:Bank 段。
 *
 * QIF 规范里日期是 M/D/YY（美式），但导出这种文件的软件遍地都是，实际写法
 * 并不统一。所以这里走与 CSV 完全相同的那条路：先分类、再由整份文件推导，
 * 推导不出来就报错要求指定——不因为「规范上是美式」就默认按美式读。
 */
export function parseQifBuffer(buffer: Buffer, options: ParseOptions): ParsedTransaction[] {
  const text = buffer.toString('utf-8').replace(/\r\n/g, '\n');

  type Draft = { cell: DateCell; rawDate: string; amount: string; payee: string; memo: string };
  const drafts: Draft[] = [];

  // 逐行扫，用 '^' 这一行作为一笔的结束，而不是 text.split('\n^')。
  //
  // 分块写法会丢掉每个段落里的第一笔：QIF 文件长这样——
  //
  //   !Type:Bank
  //   D01/02/2026
  //   ...
  //   ^
  //
  // 也就是说 `!Type:Bank` 和紧跟它的第一笔交易在同一个块里，而那个写法
  // 判到块以 '!Type:' 开头就整块跳过了。一份只有一笔交易的对账单因此
  // 解析出零笔，界面上说「没找到任何记录」。
  let inBankSection = false;
  let current: { rawDate: string; amount: string; payee: string; memo: string } | null = null;

  const flush = () => {
    if (!current) return;
    // QIF 的日期常写成 1/2'26（撇号分隔世纪），统一成斜杠再分类。
    const cell = classifyDateCell(current.rawDate.replace(/'/g, '/'));
    if (cell.kind !== 'unknown') drafts.push({ cell, ...current });
    current = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('!')) {
      // 段落切换。!Type:Bank 之外的段（!Type:Cat 分类表、!Account 账户表、
      // !Option:... 开关）都不是银行流水。
      flush();
      inBankSection = /^!Type:Bank\b/i.test(line);
      continue;
    }

    if (!inBankSection) continue;

    if (line === '^') {
      flush();
      continue;
    }

    current ??= { rawDate: '', amount: '', payee: '', memo: '' };
    const key = line.charAt(0).toUpperCase();
    const value = line.substring(1).trim();

    if (key === 'D') current.rawDate = value;
    else if (key === 'T') current.amount = value;
    else if (key === 'P') current.payee = value;
    else if (key === 'M') current.memo = value;
  }

  // 有些导出工具不给最后一笔写 '^'。
  flush();

  const order = resolveNumericOrder(
    drafts.map((d) => d.cell),
    options.dateFormat,
  );

  return drafts.flatMap((draft, index) => {
    const date = resolveCell(draft.cell, order);
    if (!date) return [];

    let amountMinor: bigint;
    try {
      amountMinor = parseStatementAmountToMinor(draft.amount, options.exponent);
    } catch (error) {
      if (error instanceof BankImportError) {
        throw new BankImportError(`Entry ${index + 1} (${draft.rawDate}): ${error.message}`);
      }
      throw error;
    }

    return [
      {
        date,
        description: draft.payee || draft.memo || '',
        amountMinor,
        rawRow: { D: draft.rawDate, T: draft.amount, P: draft.payee, M: draft.memo },
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function findHeaderIndex(headers: string[], pattern: RegExp): number {
  return headers.findIndex((h) => pattern.test(h));
}

function parseOfxDate(value: string): string | null {
  if (!value || value.length < 8) return null;
  const year = parseInt(value.substring(0, 4), 10);
  const month = parseInt(value.substring(4, 6), 10);
  const day = parseInt(value.substring(6, 8), 10);
  if (!/^\d{8}/.test(value)) return null;
  return toIso(year, month, day);
}

/**
 * 取出 OFX 块里某个标签的值。
 *
 * 终止符必须是「下一个 `<` 或者块结束」，不能只认 `<`。OFX 的 SGML 写法
 * 不给叶子标签写闭合标签，所以块里最后一个标签（常见的就是 <NAME> 或
 * <MEMO>）后面什么都没有——只认 `<` 时它会被读成空串，一笔交易的摘要
 * 就此消失，而对账界面上全靠摘要认这是哪一笔。
 */
function extractOfxTag(block: string, tag: string): string {
  const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*(?:<|$)`, 'i');
  const match = regex.exec(block);
  return match ? match[1].trim() : '';
}
