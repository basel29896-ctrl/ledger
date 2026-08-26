import { describe, expect, it } from 'vitest';
import {
  applyRules,
  decimalToMinor,
  parseCamt053Statement,
  parseCsvStatement,
  parseMt940Statement,
  parseOfxStatement,
  parseStatement,
  reconcile,
  referencesAgree,
  similarity,
  StatementParseError,
  suggestMatches,
  type BankRule,
  type LedgerCandidate,
  type StatementLineForMatch,
} from '../src/index';

describe('decimal to minor units', () => {
  it('respects the currency exponent', () => {
    expect(decimalToMinor('1160.125', 3)).toBe(1160125n);
    expect(decimalToMinor('99.99', 2)).toBe(9999n);
    expect(decimalToMinor('1500', 0)).toBe(1500n);
  });

  it('handles signs and thousands separators', () => {
    expect(decimalToMinor('-1,234.56', 2)).toBe(-123456n);
    expect(decimalToMinor('+0.01', 2)).toBe(1n);
  });

  it('refuses precision the currency cannot hold rather than rounding it away', () => {
    expect(() => decimalToMinor('1.0005', 3)).toThrow(StatementParseError);
  });

  it('refuses nonsense', () => {
    expect(() => decimalToMinor('abc', 2)).toThrow(StatementParseError);
    expect(() => decimalToMinor('', 2)).toThrow(StatementParseError);
  });
});

describe('CSV statements', () => {
  const csv = [
    'Date,Description,Reference,Money In,Money Out',
    '2026-01-05,"PETRA TRADING, LLC",INV-1001,1160.000,',
    '2026-01-07,ELECTRICITY BILL,,,250.000',
    '2026-01-09,BANK CHARGES,,,5.500',
  ].join('\n');

  const mapping = {
    dateColumn: 'Date',
    descriptionColumn: 'Description',
    referenceColumn: 'Reference',
    creditColumn: 'Money In',
    debitColumn: 'Money Out',
  };

  it('signs money in as positive and money out as negative', () => {
    const parsed = parseCsvStatement(csv, mapping, 3);
    expect(parsed.lines.map((l) => l.amountMinor)).toEqual([1_160_000n, -250_000n, -5_500n]);
  });

  it('keeps a comma inside a quoted field', () => {
    const parsed = parseCsvStatement(csv, mapping, 3);
    expect(parsed.lines[0]?.description).toBe('PETRA TRADING, LLC');
  });

  it('accepts a single signed amount column', () => {
    const signed = 'Date,Description,Amount\n2026-01-05,IN,1160.000\n2026-01-07,OUT,-250.000';
    const parsed = parseCsvStatement(
      signed,
      { dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' },
      3,
    );
    expect(parsed.lines.map((l) => l.amountMinor)).toEqual([1_160_000n, -250_000n]);
  });

  it('accepts dd/mm/yyyy dates', () => {
    const parsed = parseCsvStatement(
      'Date,Description,Amount\n05/01/2026,X,1.000',
      { dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' },
      3,
    );
    expect(parsed.lines[0]?.bookingDate).toBe('2026-01-05');
  });

  it('names the row when an amount is unreadable', () => {
    const bad = 'Date,Description,Amount\n2026-01-05,X,not-a-number';
    expect(() =>
      parseCsvStatement(
        bad,
        { dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' },
        3,
      ),
    ).toThrow(/Line 2/);
  });

  it('rejects a mapping that names a column the file does not have', () => {
    expect(() =>
      parseCsvStatement(csv, { ...mapping, dateColumn: 'Nope' }, 3),
    ).toThrow(/not in the file header/);
  });
});

describe('OFX statements', () => {
  const ofx = `
OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>JOD
<BANKACCTFROM><ACCTID>0001234567
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260105<TRNAMT>1160.000<FITID>FIT-1<NAME>PETRA TRADING<MEMO>Invoice 1001</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260107<TRNAMT>-250.000<FITID>FIT-2<NAME>ELECTRICITY</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>910.000<DTASOF>20260131</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it('reads transactions, currency and account id', () => {
    const parsed = parseOfxStatement(ofx, 3);
    expect(parsed.currency).toBe('JOD');
    expect(parsed.accountIdentifier).toBe('0001234567');
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]?.externalId).toBe('FIT-1');
    expect(parsed.lines[0]?.amountMinor).toBe(1_160_000n);
    expect(parsed.lines[1]?.amountMinor).toBe(-250_000n);
  });

  it('reads the closing ledger balance', () => {
    expect(parseOfxStatement(ofx, 3).closingBalanceMinor).toBe(910_000n);
  });

  it('rejects a file that is not OFX', () => {
    expect(() => parseOfxStatement('hello', 3)).toThrow(/is this an OFX file/);
  });
});

describe('MT940 statements', () => {
  const mt940 = [
    ':20:STMT001',
    ':25:JO94CBJO0010000000000131000302',
    ':28C:00001/001',
    ':60F:C260101JOD1000,00',
    ':61:2601050105C1160,00NTRFINV-1001//FIT-1',
    ':86:PETRA TRADING LLC INVOICE 1001',
    ':61:2601070107D250,00NTRFELEC//FIT-2',
    ':86:ELECTRICITY BILL JANUARY',
    'CONTINUED LINE',
    ':62F:C260131JOD1910,00',
    '-',
  ].join('\n');

  it('reads the account, currency and balances', () => {
    const parsed = parseMt940Statement(mt940, 2);
    expect(parsed.accountIdentifier).toBe('JO94CBJO0010000000000131000302');
    expect(parsed.currency).toBe('JOD');
    expect(parsed.openingBalanceMinor).toBe(100_000n);
    expect(parsed.closingBalanceMinor).toBe(191_000n);
  });

  it('signs credits positive and debits negative', () => {
    const parsed = parseMt940Statement(mt940, 2);
    expect(parsed.lines.map((l) => l.amountMinor)).toEqual([116_000n, -25_000n]);
  });

  it('joins a continued :86: description', () => {
    const parsed = parseMt940Statement(mt940, 2);
    expect(parsed.lines[1]?.description).toBe('ELECTRICITY BILL JANUARY CONTINUED LINE');
  });

  it('reads both value and booking dates', () => {
    const parsed = parseMt940Statement(mt940, 2);
    expect(parsed.lines[0]?.valueDate).toBe('2026-01-05');
    expect(parsed.lines[0]?.bookingDate).toBe('2026-01-05');
  });

  it('rejects a file with no statement lines', () => {
    expect(() => parseMt940Statement(':20:EMPTY\n', 2)).toThrow(/No :61:/);
  });
});

describe('CAMT.053 statements', () => {
  const camt = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Acct><Id><IBAN>JO94CBJO0010000000000131000302</IBAN></Id><Ccy>JOD</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="JOD">1000.000</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="JOD">1910.000</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="JOD">1160.000</Amt><CdtDbtInd>CRDT</CdtDbtInd>
  <BookgDt><Dt>2026-01-05</Dt></BookgDt><ValDt><Dt>2026-01-05</Dt></ValDt>
  <AcctSvcrRef>REF-1</AcctSvcrRef>
  <NtryDtls><TxDtls><Refs><EndToEndId>INV-1001</EndToEndId></Refs>
  <RltdPties><Dbtr><Nm>Petra Trading LLC</Nm></Dbtr></RltdPties></TxDtls></NtryDtls>
  <AddtlNtryInf>Invoice 1001 settlement</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="JOD">250.000</Amt><CdtDbtInd>DBIT</CdtDbtInd>
  <BookgDt><Dt>2026-01-07</Dt></BookgDt><AcctSvcrRef>REF-2</AcctSvcrRef>
  <AddtlNtryInf>Electricity</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

  it('reads the IBAN, currency and both balances', () => {
    const parsed = parseCamt053Statement(camt, 3);
    expect(parsed.accountIdentifier).toBe('JO94CBJO0010000000000131000302');
    expect(parsed.currency).toBe('JOD');
    expect(parsed.openingBalanceMinor).toBe(1_000_000n);
    expect(parsed.closingBalanceMinor).toBe(1_910_000n);
  });

  it('signs DBIT negative and CRDT positive', () => {
    const parsed = parseCamt053Statement(camt, 3);
    expect(parsed.lines.map((l) => l.amountMinor)).toEqual([1_160_000n, -250_000n]);
  });

  it('reads the end-to-end reference and the counterparty', () => {
    const parsed = parseCamt053Statement(camt, 3);
    expect(parsed.lines[0]?.reference).toBe('INV-1001');
    expect(parsed.lines[0]?.counterparty).toBe('Petra Trading LLC');
  });

  it('rejects a file that is not CAMT.053', () => {
    expect(() => parseCamt053Statement('<html/>', 3)).toThrow(/is this a CAMT.053 file/);
  });
});

describe('format dispatch', () => {
  it('routes each format to its parser', () => {
    expect(
      parseStatement('csv', 'Date,Description,Amount\n2026-01-05,X,1.000', {
        exponent: 3,
        csvMapping: { dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' },
      }).lines,
    ).toHaveLength(1);
  });

  it('insists on a mapping for CSV', () => {
    expect(() => parseStatement('csv', 'a,b', { exponent: 3 })).toThrow(/column mapping/);
  });
});

describe('text similarity', () => {
  it('is 1 for identical text once normalised', () => {
    expect(similarity('PETRA TRADING LLC', 'petra-trading, llc')).toBe(1);
  });

  it('is 0 for unrelated text', () => {
    expect(similarity('electricity', 'zzz')).toBeLessThan(0.2);
  });

  it('scores a partial overlap between', () => {
    const score = similarity('PETRA TRADING LLC', 'PETRA TRADING');
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(1);
  });

  it('treats empty input as no similarity', () => {
    expect(similarity('', 'anything')).toBe(0);
  });
});

describe('reference agreement', () => {
  it('accepts one reference containing the other', () => {
    expect(referencesAgree('INV-1001', 'Payment for INV1001')).toBe(true);
  });

  it('refuses very short references, which would match everything', () => {
    expect(referencesAgree('1', '1')).toBe(false);
  });

  it('refuses unrelated references', () => {
    expect(referencesAgree('INV-1001', 'INV-2002')).toBe(false);
  });
});

describe('match suggestions', () => {
  const lines: StatementLineForMatch[] = [
    {
      id: 'sl-1',
      bookingDate: '2026-01-05',
      description: 'PETRA TRADING LLC INV-1001',
      reference: 'INV-1001',
      counterparty: 'PETRA TRADING LLC',
      amountMinor: 1_160_000n,
    },
    {
      id: 'sl-2',
      bookingDate: '2026-01-07',
      description: 'ELECTRICITY BILL',
      reference: null,
      counterparty: null,
      amountMinor: -250_000n,
    },
    {
      id: 'sl-3',
      bookingDate: '2026-01-09',
      description: 'UNKNOWN DEPOSIT',
      reference: null,
      counterparty: null,
      amountMinor: 999_000n,
    },
  ];

  const candidates: LedgerCandidate[] = [
    {
      id: 'p-1',
      kind: 'payment',
      date: '2026-01-05',
      description: 'Customer receipt',
      reference: 'INV-1001',
      counterpartyName: 'Petra Trading LLC',
      amountMinor: 1_160_000n,
    },
    {
      id: 'p-2',
      kind: 'payment',
      date: '2026-01-06',
      description: 'Electricity bill payment',
      reference: null,
      counterpartyName: 'Jordan Electric',
      amountMinor: -250_000n,
    },
  ];

  it('matches exactly when amount, date and reference agree', () => {
    const suggestions = suggestMatches(lines, candidates);
    const first = suggestions.find((s) => s.statementLineId === 'sl-1');
    expect(first?.candidateId).toBe('p-1');
    expect(first?.confidence).toBe('exact');
    expect(first?.score).toBe(100);
  });

  it('matches on amount and date when it is the only candidate that fits', () => {
    const suggestions = suggestMatches(lines, candidates);
    const second = suggestions.find((s) => s.statementLineId === 'sl-2');
    expect(second?.candidateId).toBe('p-2');
    expect(second?.confidence).toBe('high');
  });

  it('leaves a line with no candidate unmatched', () => {
    const suggestions = suggestMatches(lines, candidates);
    expect(suggestions.find((s) => s.statementLineId === 'sl-3')).toBeUndefined();
  });

  it('never uses one ledger entry for two statement lines', () => {
    const duplicated = [...lines, { ...lines[0]!, id: 'sl-4' }];
    const suggestions = suggestMatches(duplicated, candidates);
    const used = suggestions.map((s) => s.candidateId);
    expect(new Set(used).size).toBe(used.length);
  });

  it('refuses to choose between two equally plausible candidates', () => {
    const ambiguous: LedgerCandidate[] = [
      { id: 'a', kind: 'payment', date: '2026-01-06', description: 'Rent payment', reference: null, counterpartyName: null, amountMinor: -500_000n },
      { id: 'b', kind: 'payment', date: '2026-01-06', description: 'Rent payment', reference: null, counterpartyName: null, amountMinor: -500_000n },
    ];
    const line: StatementLineForMatch = {
      id: 'sl-x',
      bookingDate: '2026-01-06',
      description: 'RENT PAYMENT',
      reference: null,
      counterparty: null,
      amountMinor: -500_000n,
    };
    expect(suggestMatches([line], ambiguous)).toHaveLength(0);
  });

  it('makes a probable match on description inside the wider window', () => {
    const late: LedgerCandidate[] = [
      {
        id: 'c-1',
        kind: 'journal_entry',
        date: '2026-01-01',
        description: 'Office rent for January',
        reference: null,
        counterpartyName: null,
        amountMinor: -300_000n,
      },
    ];
    const line: StatementLineForMatch = {
      id: 'sl-y',
      bookingDate: '2026-01-09',
      description: 'OFFICE RENT JANUARY',
      reference: null,
      counterparty: null,
      amountMinor: -300_000n,
    };
    const [suggestion] = suggestMatches([line], late);
    expect(suggestion?.confidence).toBe('probable');
    expect(suggestion?.reason).toMatch(/description match/);
  });

  it('does not match on amount alone when the description disagrees', () => {
    const unrelated: LedgerCandidate[] = [
      {
        id: 'c-2',
        kind: 'journal_entry',
        date: '2026-01-01',
        description: 'Completely unrelated posting',
        reference: null,
        counterpartyName: null,
        amountMinor: -300_000n,
      },
    ];
    const line: StatementLineForMatch = {
      id: 'sl-z',
      bookingDate: '2026-01-09',
      description: 'SOMETHING ELSE ENTIRELY',
      reference: null,
      counterparty: null,
      amountMinor: -300_000n,
    };
    expect(suggestMatches([line], unrelated)).toHaveLength(0);
  });
});

describe('bank rules', () => {
  const rules: BankRule[] = [
    {
      id: 'r-2',
      priority: 20,
      descriptionContains: 'BANK CHARGES',
      accountId: 'acc-charges',
      direction: 'out',
    },
    {
      id: 'r-1',
      priority: 10,
      descriptionContains: 'ELECTRICITY',
      accountId: 'acc-utilities',
      contactId: 'vendor-1',
      direction: 'out',
    },
  ];

  const line = (description: string, amountMinor: bigint): StatementLineForMatch => ({
    id: 'sl',
    bookingDate: '2026-01-07',
    description,
    reference: null,
    counterparty: null,
    amountMinor,
  });

  it('applies the matching rule', () => {
    const match = applyRules(line('MONTHLY ELECTRICITY BILL', -250_000n), rules);
    expect(match?.rule.accountId).toBe('acc-utilities');
    expect(match?.rule.contactId).toBe('vendor-1');
  });

  it('applies rules in priority order', () => {
    const both: BankRule[] = [
      { id: 'low', priority: 5, descriptionContains: 'BILL', accountId: 'acc-low', direction: 'out' },
      { id: 'high', priority: 50, descriptionContains: 'ELECTRICITY', accountId: 'acc-high', direction: 'out' },
    ];
    expect(applyRules(line('ELECTRICITY BILL', -1n), both)?.rule.accountId).toBe('acc-low');
  });

  it('respects the direction condition', () => {
    expect(applyRules(line('ELECTRICITY REFUND', 250_000n), rules)).toBeNull();
  });

  it('respects amount bounds', () => {
    const bounded: BankRule[] = [
      {
        id: 'r',
        priority: 1,
        descriptionContains: 'FEE',
        accountId: 'acc-fee',
        minAmountMinor: 1_000n,
        maxAmountMinor: 10_000n,
      },
    ];
    expect(applyRules(line('CARD FEE', -500n), bounded)).toBeNull();
    expect(applyRules(line('CARD FEE', -5_000n), bounded)?.rule.accountId).toBe('acc-fee');
    expect(applyRules(line('CARD FEE', -50_000n), bounded)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(applyRules(line('MYSTERY PAYMENT', -1n), rules)).toBeNull();
  });
});

describe('reconciliation', () => {
  it('reconciles when the identity holds', () => {
    const result = reconcile({
      statementClosingMinor: 1_910_000n,
      ledgerBalanceMinor: 1_910_000n,
      unmatchedStatementMinor: 0n,
      unmatchedLedgerMinor: 0n,
    });
    expect(result.reconciled).toBe(true);
    expect(result.differenceMinor).toBe(0n);
  });

  it('accounts for a cheque not yet presented', () => {
    // The ledger shows a payment the bank has not seen: ledger is lower by 250.
    const result = reconcile({
      statementClosingMinor: 1_910_000n,
      ledgerBalanceMinor: 1_660_000n,
      unmatchedStatementMinor: 0n,
      unmatchedLedgerMinor: 250_000n,
    });
    expect(result.reconciled).toBe(true);
  });

  it('reports the gap when it does not reconcile', () => {
    const result = reconcile({
      statementClosingMinor: 1_910_000n,
      ledgerBalanceMinor: 1_900_000n,
      unmatchedStatementMinor: 0n,
      unmatchedLedgerMinor: 0n,
    });
    expect(result.reconciled).toBe(false);
    expect(result.differenceMinor).toBe(10_000n);
  });
});
