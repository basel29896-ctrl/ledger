'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AccountDto, JournalEntryDto } from '@acct/shared';
import { api } from '../../../lib/api';
import { useSession, can } from '../../../lib/session';
import { formatMoney, fromMinorUnits, sumMinor, toMinorUnits } from '../../../lib/money';
import {
  Button,
  Card,
  DataTable,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  THead,
  Td,
  Th,
} from '../../../components/ui';

interface DraftLine {
  key: string;
  accountId: string;
  side: 'debit' | 'credit';
  amount: string;
  description: string;
}

let keySeed = 0;
const newLine = (side: 'debit' | 'credit' = 'debit'): DraftLine => ({
  key: `line-${(keySeed += 1)}`,
  accountId: '',
  side,
  amount: '',
  description: '',
});

/**
 * The journal entry screen.
 *
 * Three rules from the specification are visible here:
 *  - a live running total with an out-of-balance indicator;
 *  - Post is disabled until the entry balances;
 *  - nothing is optimistic — the entry appears only after the server confirms it.
 */
export default function NewJournalEntryPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([newLine('debit'), newLine('credit')]);
  const rowRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<AccountDto[]>('/accounts'),
  });
  const postable = useMemo(() => accounts.filter((a) => a.isPostable && a.isActive), [accounts]);

  // The tenant base currency drives how many decimals an amount may carry.
  const currency = 'JOD';

  const totals = useMemo(() => {
    const debits: string[] = [];
    const credits: string[] = [];
    let invalid = false;
    for (const line of lines) {
      if (!line.amount.trim()) continue;
      const minor = toMinorUnits(line.amount, currency);
      if (minor === null) {
        invalid = true;
        continue;
      }
      (line.side === 'debit' ? debits : credits).push(minor);
    }
    const debit = sumMinor(debits);
    const credit = sumMinor(credits);
    return { debit, credit, difference: debit - credit, invalid };
  }, [lines]);

  const filledLines = lines.filter((l) => l.accountId && toMinorUnits(l.amount, currency));
  const balanced =
    !totals.invalid && totals.difference === 0n && totals.debit > 0n && filledLines.length >= 2;

  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const save = useMutation({
    mutationFn: (status: 'draft' | 'posted') =>
      api.post<JournalEntryDto>(
        '/journal-entries',
        {
          entryDate,
          status,
          ...(memo ? { memo } : {}),
          lines: filledLines.map((line) => ({
            accountId: line.accountId,
            side: line.side,
            amountMinor: toMinorUnits(line.amount, currency)!,
            ...(line.description ? { description: line.description } : {}),
          })),
        },
        // A retry of the same submission must not create a second entry.
        { 'Idempotency-Key': idempotencyKey },
      ),
    onSuccess: (entry) => router.push(`/journal/${entry.id}`),
  });

  const addLine = (side: 'debit' | 'credit' = 'debit'): void => {
    const line = newLine(side);
    setLines((prev) => [...prev, line]);
    setTimeout(() => rowRefs.current[line.key]?.focus(), 0);
  };

  const duplicateLine = (index: number): void => {
    const source = lines[index];
    if (!source) return;
    const copy = { ...source, key: `line-${(keySeed += 1)}` };
    setLines((prev) => [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)]);
  };

  const update = (key: string, patch: Partial<DraftLine>): void => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  /** Keyboard shortcuts: the target user rarely reaches for the mouse. */
  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      addLine(totals.difference > 0n ? 'credit' : 'debit');
    } else if (event.key === 'd' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      duplicateLine(index);
    } else if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save.mutate('draft');
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && balanced) {
      event.preventDefault();
      save.mutate('posted');
    }
  };

  const money = (minor: bigint): string =>
    formatMoney({ amount: fromMinorUnits(minor.toString(), currency), minor: '', currency });

  return (
    <>
      <PageHeader
        title="New journal entry"
        subtitle="Enter: new line · Ctrl+D: duplicate · Ctrl+S: save draft · Ctrl+Enter: post"
      />

      <ErrorBanner error={save.error} />

      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Entry date">
            <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Memo">
              <Input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="What is this entry for?"
              />
            </Field>
          </div>
        </div>
      </Card>

      <DataTable>
        <THead>
          <tr>
            <Th className="w-10">#</Th>
            <Th>Account</Th>
            <Th className="w-28">Side</Th>
            <Th numeric className="w-40">
              Amount
            </Th>
            <Th>Description</Th>
            <Th className="w-16" />
          </tr>
        </THead>
        <tbody>
          {lines.map((line, index) => {
            const parsed = line.amount.trim() ? toMinorUnits(line.amount, currency) : '';
            const bad = line.amount.trim() !== '' && parsed === null;
            return (
              <tr key={line.key} className="border-b border-ice-100 last:border-0 hover:bg-ice-50/60">
                <Td muted className="text-xs">
                  {index + 1}
                </Td>
                <Td className="py-1">
                  <Select
                    value={line.accountId}
                    onChange={(e) => update(line.key, { accountId: e.target.value })}
                    onKeyDown={(e) => onKeyDown(e, index)}
                  >
                    <option value="">— select account —</option>
                    {postable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td className="py-1">
                  <Select
                    value={line.side}
                    onChange={(e) => update(line.key, { side: e.target.value as 'debit' | 'credit' })}
                    onKeyDown={(e) => onKeyDown(e, index)}
                  >
                    <option value="debit">Debit</option>
                    <option value="credit">Credit</option>
                  </Select>
                </Td>
                <Td className="py-1">
                  <Input
                    ref={(el: HTMLInputElement | null) => {
                      rowRefs.current[line.key] = el;
                    }}
                    inputMode="decimal"
                    aria-label={`Amount, line ${index + 1}`}
                    value={line.amount}
                    onChange={(e) => update(line.key, { amount: e.target.value })}
                    onKeyDown={(e) => onKeyDown(e, index)}
                    className={`text-end amount ${bad ? 'border-flag-500 focus:ring-flag-200' : ''}`}
                    placeholder="0.000"
                  />
                </Td>
                <Td className="py-1">
                  <Input
                    aria-label={`Description, line ${index + 1}`}
                    value={line.description}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                    onKeyDown={(e) => onKeyDown(e, index)}
                  />
                </Td>
                <Td className="py-1 text-end">
                  <button
                    type="button"
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                    className="text-xs text-ink-400 transition-colors hover:text-flag-500 disabled:opacity-40 disabled:hover:text-ink-400"
                    disabled={lines.length <= 2}
                  >
                    remove
                  </button>
                </Td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 border-ink-200 bg-ice-50">
          <tr>
            <td colSpan={3} className="px-3 py-2 text-end text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Totals
            </td>
            <td className="amount px-3 py-2 text-end">
              <div className="text-xs text-ink-500">Dr {money(totals.debit)}</div>
              <div className="text-xs text-ink-500">Cr {money(totals.credit)}</div>
            </td>
            <td colSpan={2} className="px-3 py-2">
              {totals.invalid ? (
                <span className="text-sm font-medium text-flag-500">
                  An amount has more decimals than {currency} allows.
                </span>
              ) : totals.difference === 0n ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-mint-200 px-2 py-0.5 text-sm font-medium text-mint-700">
                  Balanced
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-flag-100 px-2 py-0.5 text-sm font-medium text-flag-600">
                  Out of balance by{' '}
                  {money(totals.difference < 0n ? -totals.difference : totals.difference)} (
                  {totals.difference > 0n ? 'debits exceed credits' : 'credits exceed debits'})
                </span>
              )}
            </td>
          </tr>
        </tfoot>
      </DataTable>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => addLine()} type="button">
          Add line
        </Button>
        <div className="ms-auto flex items-center gap-2">
          {!can(session, 'ledger.entry.post') ? (
            <span className="text-xs text-ink-400">
              You may save drafts. Posting requires the ledger.entry.post permission.
            </span>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => save.mutate('draft')}
            disabled={save.isPending || filledLines.length < 2}
          >
            Save draft
          </Button>
          <Button
            onClick={() => save.mutate('posted')}
            disabled={!balanced || save.isPending || !can(session, 'ledger.entry.post')}
            title={balanced ? 'Post this entry' : 'The entry must balance before it can be posted'}
          >
            {save.isPending ? 'Posting…' : 'Post entry'}
          </Button>
        </div>
      </div>
    </>
  );
}
