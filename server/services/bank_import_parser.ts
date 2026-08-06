export type ParsedTransaction = {
  date: string;
  description: string;
  amount: string;
  rawRow: Record<string, string>;
};

/**
 * Parse a CSV buffer into ParsedTransaction[].
 * Auto-detects headers and looks for columns matching date/description/amount patterns.
 */
export function parseCsvBuffer(buffer: Buffer): ParsedTransaction[] {
  const text = buffer.toString('utf-8').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine);
  const dataLines = lines.slice(1).filter((line) => line.trim() !== '');

  // Auto-detect column indices
  const dateIdx = findHeaderIndex(headers, /date/i);
  const descIdx = findHeaderIndex(headers, /description|memo|payee|name|narrative/i);
  const amountIdx = findHeaderIndex(headers, /amount|sum|value/i);

  // If we can't find amount, try to find debit/credit columns
  const debitIdx = amountIdx === -1 ? findHeaderIndex(headers, /debit|withdrawal|payment/i) : -1;
  const creditIdx = amountIdx === -1 ? findHeaderIndex(headers, /credit|deposit|income/i) : -1;

  if (dateIdx === -1) return [];

  const results: ParsedTransaction[] = [];

  for (const line of dataLines) {
    const fields = parseCsvLine(line);
    if (fields.length <= dateIdx) continue;

    const date = parseDate(fields[dateIdx]);
    if (!date) continue;

    const description = descIdx !== -1 && descIdx < fields.length ? fields[descIdx] : '';

    let amount = '0';
    if (amountIdx !== -1 && amountIdx < fields.length) {
      amount = normalizeAmount(fields[amountIdx]);
    } else if (debitIdx !== -1 && creditIdx !== -1) {
      const debit = debitIdx < fields.length ? normalizeAmount(fields[debitIdx]) : '0';
      const credit = creditIdx < fields.length ? normalizeAmount(fields[creditIdx]) : '0';
      const debitNum = parseFloat(debit) || 0;
      const creditNum = parseFloat(credit) || 0;
      amount = (creditNum - debitNum).toFixed(2);
    }

    const rawRow: Record<string, string> = {};
    headers.forEach((header, i) => {
      rawRow[header] = i < fields.length ? fields[i] : '';
    });

    results.push({ date, description, amount, rawRow });
  }

  return results;
}

/**
 * Parse an OFX/QFX buffer into ParsedTransaction[].
 * Extracts STMTTRN entries with DTPOSTED, TRNAMT, NAME/MEMO.
 */
export function parseOfxBuffer(buffer: Buffer): ParsedTransaction[] {
  const text = buffer.toString('utf-8');
  const results: ParsedTransaction[] = [];

  // Find all STMTTRN blocks
  const txnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match: RegExpExecArray | null;

  while ((match = txnRegex.exec(text)) !== null) {
    const block = match[1];

    const dtposted = extractOfxTag(block, 'DTPOSTED');
    const trnamt = extractOfxTag(block, 'TRNAMT');
    const name = extractOfxTag(block, 'NAME');
    const memo = extractOfxTag(block, 'MEMO');

    const date = parseOfxDate(dtposted);
    if (!date) continue;

    const description = name || memo || '';
    const amount = trnamt || '0';

    results.push({
      date,
      description,
      amount,
      rawRow: { DTPOSTED: dtposted, TRNAMT: trnamt, NAME: name, MEMO: memo },
    });
  }

  return results;
}

/**
 * Parse a QIF buffer into ParsedTransaction[].
 * Extracts !Type:Bank entries with D (date), T (amount), P (payee), M (memo).
 */
export function parseQifBuffer(buffer: Buffer): ParsedTransaction[] {
  const text = buffer.toString('utf-8').replace(/\r\n/g, '\n');
  const results: ParsedTransaction[] = [];

  // Split by ^ (end of entry marker)
  const entries = text.split('\n^');
  // Find the bank section
  let inBankSection = false;

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('!Type:Bank')) {
      inBankSection = true;
      continue;
    }

    // Skip other sections
    if (trimmed.startsWith('!Type:')) {
      inBankSection = false;
      continue;
    }

    if (!inBankSection) continue;

    const lines = trimmed.split('\n');
    let date = '';
    let amount = '';
    let payee = '';
    let memo = '';

    for (const line of lines) {
      const key = line.charAt(0).toUpperCase();
      const value = line.substring(1).trim();

      switch (key) {
        case 'D':
          date = parseQifDate(value);
          break;
        case 'T':
          amount = value;
          break;
        case 'P':
          payee = value;
          break;
        case 'M':
          memo = value;
          break;
      }
    }

    if (!date) continue;

    const description = payee || memo || '';

    results.push({
      date,
      description,
      amount,
      rawRow: { D: date, T: amount, P: payee, M: memo },
    });
  }

  return results;
}

// ---- helpers ----

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

function parseDate(value: string): string | null {
  if (!value || value.trim() === '') return null;

  const cleaned = value.trim();

  // Try YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Try DD/MM/YYYY or MM/DD/YYYY
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cleaned);
  if (slash) {
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    // Heuristic: if first part > 12, it's DD/MM/YYYY; otherwise assume MM/DD/YYYY
    if (a > 12) {
      return `${slash[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
    return `${slash[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }

  // Try DD-Mon-YYYY (e.g., 01-Jan-2025)
  const mon = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(cleaned);
  if (mon) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const m = months[mon[2].toLowerCase()];
    if (m) {
      return `${mon[3]}-${m}-${mon[1].padStart(2, '0')}`;
    }
  }

  return null;
}

function parseOfxDate(value: string): string | null {
  if (!value || value.length < 8) return null;
  // OFX date format: YYYYMMDD or YYYYMMDDHHMMSS
  const y = value.substring(0, 4);
  const m = value.substring(4, 6);
  const d = value.substring(6, 8);
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;
  return `${y}-${m}-${d}`;
}

function parseQifDate(value: string): string {
  if (!value) return '';
  // QIF date: M/D/YYYY or M/D/YY
  const parts = value.split(/[/'\-]/);
  if (parts.length < 3) return value;
  let month = parts[0].padStart(2, '0');
  let day = parts[1].padStart(2, '0');
  let year = parts[2];
  if (year.length === 2) {
    year = (parseInt(year, 10) < 50 ? '20' : '19') + year;
  }
  return `${year}-${month}-${day}`;
}

function extractOfxTag(block: string, tag: string): string {
  const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<`, 'i');
  const match = regex.exec(block);
  return match ? match[1].trim() : '';
}

function normalizeAmount(value: string): string {
  if (!value) return '0';
  // Remove currency symbols, commas, spaces
  let cleaned = value.replace(/[$€£¥,\s]/g, '');
  // Handle parentheses for negative values: (123.45) -> -123.45
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }
  // If it ends with a minus sign, move it to front
  if (cleaned.endsWith('-')) {
    cleaned = '-' + cleaned.slice(0, -1);
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? '0' : num.toFixed(2);
}
