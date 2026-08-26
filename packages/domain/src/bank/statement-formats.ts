/**
 * Bank statement parsers.
 *
 * Four formats, one shape out. Every parser returns amounts as signed minor
 * units in the statement currency: positive is money in, negative is money out.
 * Parsing never rounds — if a file states an amount the currency cannot
 * represent, that is an error in the file and the parser says so rather than
 * quietly dropping a fil.
 */

export interface ParsedStatementLine {
  /** The bank's own identifier for the entry, when it provides one. */
  readonly externalId: string | null;
  readonly bookingDate: string;
  readonly valueDate: string | null;
  readonly description: string;
  readonly reference: string | null;
  readonly counterparty: string | null;
  /** Signed minor units: positive = received, negative = paid. */
  readonly amountMinor: bigint;
}

export interface ParsedStatement {
  readonly accountIdentifier: string | null;
  readonly currency: string | null;
  readonly openingBalanceMinor: bigint | null;
  readonly closingBalanceMinor: bigint | null;
  readonly statementDate: string | null;
  readonly lines: readonly ParsedStatementLine[];
}

export class StatementParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
    this.name = 'StatementParseError';
  }
}

/** Decimal string to minor units, exact, no floating point anywhere. */
export function decimalToMinor(value: string, exponent: number): bigint {
  const trimmed = value.trim().replace(/\s/g, '').replace(/,/g, '');
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new StatementParseError(`Not a valid amount: "${value}"`);
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new StatementParseError(
      `Amount "${value}" has ${fraction.length} decimals but the currency allows ${exponent}`,
    );
  }
  const digits = `${whole || '0'}${fraction.padEnd(exponent, '0')}`;
  const magnitude = BigInt(digits === '' ? '0' : digits);
  return sign === '-' ? -magnitude : magnitude;
}

function normaliseDate(value: string): string {
  const trimmed = value.trim();
  // ISO
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  // dd/mm/yyyy or dd-mm-yyyy
  match = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(trimmed);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  // yyyymmdd
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  throw new StatementParseError(`Not a recognisable date: "${value}"`);
}

// --- CSV ---------------------------------------------------------------

export interface CsvMapping {
  readonly dateColumn: string;
  readonly descriptionColumn: string;
  /** A single signed column, or a debit/credit pair. */
  readonly amountColumn?: string;
  readonly debitColumn?: string;
  readonly creditColumn?: string;
  readonly referenceColumn?: string;
  readonly counterpartyColumn?: string;
  readonly externalIdColumn?: string;
  readonly delimiter?: string;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, embedded newlines. */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function parseCsvStatement(
  text: string,
  mapping: CsvMapping,
  exponent: number,
): ParsedStatement {
  const rows = parseCsvRows(text, mapping.delimiter ?? ',');
  if (rows.length < 2) throw new StatementParseError('The file has no data rows');

  const header = rows[0]!.map((h) => h.trim());
  const indexOf = (name: string | undefined): number => {
    if (!name) return -1;
    const index = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (index === -1) throw new StatementParseError(`Column "${name}" is not in the file header`);
    return index;
  };

  const dateIndex = indexOf(mapping.dateColumn);
  const descriptionIndex = indexOf(mapping.descriptionColumn);
  const amountIndex = indexOf(mapping.amountColumn);
  const debitIndex = indexOf(mapping.debitColumn);
  const creditIndex = indexOf(mapping.creditColumn);
  const referenceIndex = indexOf(mapping.referenceColumn);
  const counterpartyIndex = indexOf(mapping.counterpartyColumn);
  const externalIdIndex = indexOf(mapping.externalIdColumn);

  if (amountIndex === -1 && debitIndex === -1 && creditIndex === -1) {
    throw new StatementParseError('Map either an amount column or a debit/credit pair');
  }

  const lines: ParsedStatementLine[] = rows.slice(1).map((row, offset) => {
    const lineNo = offset + 2;
    const cell = (index: number): string => (index === -1 ? '' : (row[index] ?? '').trim());

    let amount: bigint;
    try {
      if (amountIndex !== -1) {
        amount = decimalToMinor(cell(amountIndex), exponent);
      } else {
        const debit = cell(debitIndex);
        const credit = cell(creditIndex);
        // A debit column on a bank statement is money leaving the account.
        amount =
          credit !== '' ? decimalToMinor(credit, exponent) : -decimalToMinor(debit || '0', exponent);
      }
    } catch (err) {
      throw new StatementParseError((err as Error).message, lineNo);
    }

    let bookingDate: string;
    try {
      bookingDate = normaliseDate(cell(dateIndex));
    } catch (err) {
      throw new StatementParseError((err as Error).message, lineNo);
    }

    return {
      externalId: cell(externalIdIndex) || null,
      bookingDate,
      valueDate: null,
      description: cell(descriptionIndex),
      reference: cell(referenceIndex) || null,
      counterparty: cell(counterpartyIndex) || null,
      amountMinor: amount,
    };
  });

  return {
    accountIdentifier: null,
    currency: null,
    openingBalanceMinor: null,
    closingBalanceMinor: null,
    statementDate: lines.at(-1)?.bookingDate ?? null,
    lines,
  };
}

// --- OFX ---------------------------------------------------------------

/**
 * OFX 1.x is SGML with unclosed tags; OFX 2.x is XML. Both are read with the
 * same tag scan, which tolerates either.
 */
export function parseOfxStatement(text: string, exponent: number): ParsedStatement {
  const tag = (source: string, name: string): string | null => {
    const match = new RegExp(`<${name}>([^<\r\n]*)`, 'i').exec(source);
    return match?.[1]?.trim() ?? null;
  };

  const currency = tag(text, 'CURDEF');
  const accountIdentifier = tag(text, 'ACCTID');
  const ledgerBalance = tag(text, 'BALAMT');

  const transactions = [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
  if (transactions.length === 0 && !/<STMTTRN>/i.test(text)) {
    throw new StatementParseError('No <STMTTRN> transactions found; is this an OFX file?');
  }

  const lines: ParsedStatementLine[] = transactions.map((match) => {
    const block = match[1]!;
    const amount = tag(block, 'TRNAMT');
    const posted = tag(block, 'DTPOSTED');
    if (amount === null || posted === null) {
      throw new StatementParseError('A transaction is missing TRNAMT or DTPOSTED');
    }
    return {
      externalId: tag(block, 'FITID'),
      bookingDate: normaliseDate(posted.slice(0, 8)),
      valueDate: null,
      description: tag(block, 'MEMO') ?? tag(block, 'NAME') ?? '',
      reference: tag(block, 'CHECKNUM'),
      counterparty: tag(block, 'NAME'),
      amountMinor: decimalToMinor(amount, exponent),
    };
  });

  return {
    accountIdentifier,
    currency,
    openingBalanceMinor: null,
    closingBalanceMinor: ledgerBalance === null ? null : decimalToMinor(ledgerBalance, exponent),
    statementDate: lines.at(-1)?.bookingDate ?? null,
    lines,
  };
}

// --- MT940 -------------------------------------------------------------

/**
 * SWIFT MT940. The fields that matter:
 *   :25:  account identification
 *   :60F: opening balance      :62F: closing balance
 *   :61:  statement line       :86:  information to account owner
 */
export function parseMt940Statement(text: string, exponent: number): ParsedStatement {
  const normalised = text.replace(/\r\n/g, '\n');
  const fieldPattern = /^:(\d{2}[A-Z]?):(.*)$/;

  let accountIdentifier: string | null = null;
  let currency: string | null = null;
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  const lines: ParsedStatementLine[] = [];

  const rawLines = normalised.split('\n');
  // Index of the line the next :86: (or its continuation) belongs to.
  let currentIndex = -1;

  const parseBalance = (value: string): { currency: string; amount: bigint; date: string } => {
    // e.g. C240131JOD1234,56  → credit, 31 Jan 2024, JOD 1234.56
    const match = /^([CD])(\d{6})([A-Z]{3})([\d,.]+)$/.exec(value.trim());
    if (!match) throw new StatementParseError(`Unreadable balance field: "${value}"`);
    const [, sign = 'C', date = '', code = '', amount = ''] = match;
    const magnitude = decimalToMinor(amount.replace(',', '.'), exponent);
    return {
      currency: code,
      amount: sign === 'D' ? -magnitude : magnitude,
      date: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    };
  };

  for (const raw of rawLines) {
    const match = fieldPattern.exec(raw);
    if (!match) {
      // Continuation of the previous :86: description.
      const previous = currentIndex === -1 ? undefined : lines[currentIndex];
      if (previous !== undefined && raw.trim() !== '' && !raw.startsWith('-')) {
        lines[currentIndex] = {
          ...previous,
          description: `${previous.description} ${raw.trim()}`.trim(),
        };
      }
      continue;
    }

    const [, field = '', value = ''] = match;
    switch (field) {
      case '25':
        accountIdentifier = value.trim();
        break;
      case '60F':
      case '60M': {
        const balance = parseBalance(value);
        opening = balance.amount;
        currency = balance.currency;
        break;
      }
      case '62F':
      case '62M':
        closing = parseBalance(value).amount;
        break;
      case '61': {
        // yymmdd [mmdd] C|D amount N type reference
        const line = /^(\d{6})(\d{4})?([CD])([DR])?([\d,.]+)N(\w{3})(.*)$/.exec(value.trim());
        if (!line) throw new StatementParseError(`Unreadable :61: statement line: "${value}"`);
        const [, valueDate = '', bookingDate, sign = 'C', , amount = '', , reference = ''] = line;
        const magnitude = decimalToMinor(amount.replace(',', '.'), exponent);
        const year = `20${valueDate.slice(0, 2)}`;
        const line61: ParsedStatementLine = {
          externalId: reference.split('//')[0]?.trim() || null,
          bookingDate: bookingDate
            ? `${year}-${bookingDate.slice(0, 2)}-${bookingDate.slice(2, 4)}`
            : `${year}-${valueDate.slice(2, 4)}-${valueDate.slice(4, 6)}`,
          valueDate: `${year}-${valueDate.slice(2, 4)}-${valueDate.slice(4, 6)}`,
          description: '',
          reference: reference.trim() || null,
          counterparty: null,
          amountMinor: sign === 'D' ? -magnitude : magnitude,
        };
        lines.push(line61);
        currentIndex = lines.length - 1;
        break;
      }
      case '86': {
        const previous = currentIndex === -1 ? undefined : lines[currentIndex];
        if (previous !== undefined) {
          lines[currentIndex] = { ...previous, description: value.trim() };
        }
        break;
      }
      default:
        break;
    }
  }

  if (lines.length === 0) throw new StatementParseError('No :61: statement lines found');

  return {
    accountIdentifier,
    currency,
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    statementDate: lines.at(-1)?.bookingDate ?? null,
    lines,
  };
}

// --- CAMT.053 ----------------------------------------------------------

/**
 * ISO 20022 CAMT.053. Read with a targeted tag scan rather than a full XML
 * parse: the structure needed here is small and fixed, and a scan cannot be
 * talked into resolving an external entity.
 */
export function parseCamt053Statement(xml: string, exponent: number): ParsedStatement {
  const inner = (source: string, tag: string): string | null => {
    const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(
      source,
    );
    return match?.[1] ?? null;
  };
  const value = (source: string, tag: string): string | null => {
    const found = inner(source, tag);
    return found === null ? null : found.replace(/<[^>]*>/g, '').trim();
  };

  if (!/<(?:\w+:)?Stmt\b/i.test(xml) && !/<(?:\w+:)?Ntry\b/i.test(xml)) {
    throw new StatementParseError('No <Stmt> or <Ntry> elements found; is this a CAMT.053 file?');
  }

  const accountBlock = inner(xml, 'Acct') ?? '';
  const accountIdentifier = value(accountBlock, 'IBAN') ?? value(accountBlock, 'Othr');
  const currency = value(accountBlock, 'Ccy');

  let opening: bigint | null = null;
  let closing: bigint | null = null;
  for (const match of xml.matchAll(/<(?:\w+:)?Bal\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Bal>/gi)) {
    const block = match[1]!;
    const code = value(block, 'Cd');
    const amount = value(block, 'Amt');
    const indicator = value(block, 'CdtDbtInd');
    if (amount === null) continue;
    const signed =
      indicator === 'DBIT' ? -decimalToMinor(amount, exponent) : decimalToMinor(amount, exponent);
    if (code === 'OPBD') opening = signed;
    if (code === 'CLBD') closing = signed;
  }

  const lines: ParsedStatementLine[] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?Ntry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Ntry>/gi)) {
    const block = match[1]!;
    const amount = value(block, 'Amt');
    const indicator = value(block, 'CdtDbtInd');
    const bookingBlock = inner(block, 'BookgDt') ?? '';
    const valueBlock = inner(block, 'ValDt') ?? '';
    const booking = value(bookingBlock, 'Dt') ?? value(bookingBlock, 'DtTm');
    if (amount === null || booking === null) {
      throw new StatementParseError('An <Ntry> is missing <Amt> or <BookgDt>');
    }
    const magnitude = decimalToMinor(amount, exponent);
    const relatedParties = inner(block, 'RltdPties') ?? '';

    lines.push({
      externalId: value(block, 'AcctSvcrRef') ?? value(block, 'NtryRef'),
      bookingDate: normaliseDate(booking.slice(0, 10)),
      valueDate: (() => {
        const found = value(valueBlock, 'Dt') ?? value(valueBlock, 'DtTm');
        return found === null ? null : normaliseDate(found.slice(0, 10));
      })(),
      description: value(block, 'AddtlNtryInf') ?? value(block, 'Ustrd') ?? '',
      reference: value(block, 'EndToEndId') ?? null,
      counterparty: value(relatedParties, 'Nm'),
      amountMinor: indicator === 'DBIT' ? -magnitude : magnitude,
    });
  }

  if (lines.length === 0) throw new StatementParseError('No <Ntry> entries found');

  return {
    accountIdentifier,
    currency,
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    statementDate: lines.at(-1)?.bookingDate ?? null,
    lines,
  };
}

export type StatementFormat = 'csv' | 'ofx' | 'mt940' | 'camt053';

export function parseStatement(
  format: StatementFormat,
  content: string,
  options: { exponent: number; csvMapping?: CsvMapping },
): ParsedStatement {
  switch (format) {
    case 'csv':
      if (!options.csvMapping) throw new StatementParseError('A CSV import needs a column mapping');
      return parseCsvStatement(content, options.csvMapping, options.exponent);
    case 'ofx':
      return parseOfxStatement(content, options.exponent);
    case 'mt940':
      return parseMt940Statement(content, options.exponent);
    case 'camt053':
      return parseCamt053Statement(content, options.exponent);
  }
}
