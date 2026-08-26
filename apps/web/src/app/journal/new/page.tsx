'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AccountDto, JournalEntryDto } from '@acct/shared';
import { api } from '../../../lib/api';
import { useSession, can } from '../../../lib/session';
import { formatMoney, fromMinorUnits, sumMinor, toMinorUnits } from '../../../lib/money';
import { Button, Card, ErrorBanner, Field, Input, Select } from '../../../components/ui';

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

  const [idempotencyKey] = useState(() => crypto.randomUUID());

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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">New journal entry</h1>
        <span className="text-xs text-slate-500">
          Enter: new line · Ctrl+D: duplicate · Ctrl+S: save draft · Ctrl+Enter: post
        </span>
      </div>

      <ErrorBanner error={save.error} />

      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Entry date">
            <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Memo">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What is this entry for?" />
            </Field>
          </div>
        </div>
      </Card>

      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
            <tr>
              <th className="w-8 px-2 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Account</th>
              <th className="w-24 px-2 py-2 font-medium">Side</th>
              <th className="w-40 px-2 py-2 text-right font-medium">Amount</th>
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="w-16 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const parsed = line.amount.trim() ? toMinorUnits(line.amount, currency) : '';
              const bad = line.amount.trim() !== '' && parsed === null;
              return (
                <tr key={line.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-2 py-1 text-xs text-slate-400">{index + 1}</td>
                  <td className="px-2 py-1">
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
                  </td>
                  <td className="px-2 py-1">
                    <Select
                      value={line.side}
                      onChange={(e) => update(line.key, { side: e.target.value as 'debit' | 'credit' })}
                      onKeyDown={(e) => onKeyDown(e, index)}
                    >
                      <option value="debit">Debit</option>
                      <option value="credit">Credit</option>
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      ref={(el: HTMLInputElement | null) => {
                        rowRefs.current[line.key] = el;
                      }}
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => update(line.key, { amount: e.target.value })}
                      onKeyDown={(e) => onKeyDown(e, index)}
                      className={`text-right tabular-nums ${bad ? 'border-red-500' : ''}`}
                      placeholder={`0.${'0'.repeat(3)}`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      value={line.description}
                      onChange={(e) => update(line.key, { description: e.target.value })}
                      onKeyDown={(e) => onKeyDown(e, index)}
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      className="text-xs text-slate-500 hover:text-red-700"
                      disabled={lines.length <= 2}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-slate-300 bg-slate-50">
            <tr>
              <td colSpan={3} className="px-2 py-2 text-right text-xs font-medium uppercase text-slate-600">
                Totals
              </td>
              <td className="px-2 py-2 text-right">
                <div className="tabular-nums">
                  <div>Dr {formatMoney({ amount: fromMinorUnits(totals.debit.toString(), currency), minor: '', currency })}</div>
                  <div>Cr {formatMoney({ amount: fromMinorUnits(totals.credit.toString(), currency), minor: '', currency })}</div>
                </div>
              </td>
              <td colSpan={2} className="px-2 py-2">
                {totals.invalid ? (
                  <span className="text-sm font-medium text-red-700">
                    An amount has more decimals than {currency} allows.
                  </span>
                ) : totals.difference === 0n ? (
                  <span className="text-sm font-medium text-green-700">Balanced</span>
                ) : (
                  <span className="text-sm font-medium text-red-700">
                    Out of balance by{' '}
                    {formatMoney({
                      amount: fromMinorUnits(
                        (totals.difference < 0n ? -totals.difference : totals.difference).toString(),
                        currency,
                      ),
                      minor: '',
                      currency,
                    })}{' '}
                    ({totals.difference > 0n ? 'debits exceed credits' : 'credits exceed debits'})
                  </span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => addLine()} type="button">
          Add line
        </Button>
        <div className="ml-auto flex gap-2">
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
      {!can(session, 'ledger.entry.post') ? (
        <p className="text-right text-xs text-slate-500">
          You may save drafts. Posting requires the ledger.entry.post permission.
        </p>
      ) : null}
    </div>
  );
}
