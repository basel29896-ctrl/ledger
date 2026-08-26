'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JournalEntryDto } from '@acct/shared';
import { api } from '../../../lib/api';
import { useSession, can } from '../../../lib/session';
import { Button, Card, ErrorBanner, Field, Input, Money } from '../../../components/ui';

export default function JournalEntryPage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [reason, setReason] = useState('');
  const [showReverse, setShowReverse] = useState(false);

  const { data: entry, isLoading } = useQuery({
    queryKey: ['journal-entry', params.id],
    queryFn: () => api.get<JournalEntryDto>(`/journal-entries/${params.id}`),
  });

  const post = useMutation({
    mutationFn: () => api.post<JournalEntryDto>(`/journal-entries/${params.id}/post`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['journal-entry', params.id] }),
  });

  const reverse = useMutation({
    mutationFn: () => api.post(`/journal-entries/${params.id}/reverse`, { reason }),
    onSuccess: async () => {
      setShowReverse(false);
      await queryClient.invalidateQueries({ queryKey: ['journal-entry', params.id] });
    },
  });

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!entry) return <p className="text-sm text-slate-500">Not found.</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">
          {entry.entryRef ?? 'Draft entry'}{' '}
          <span className="ml-1 text-sm font-normal text-slate-500">{entry.status}</span>
        </h1>
        <div className="ml-auto flex gap-2">
          {entry.status === 'draft' && can(session, 'ledger.entry.post') ? (
            <Button onClick={() => post.mutate()} disabled={post.isPending}>
              {post.isPending ? 'Posting…' : 'Post entry'}
            </Button>
          ) : null}
          {entry.status === 'posted' && can(session, 'ledger.entry.reverse') ? (
            <Button variant="danger" onClick={() => setShowReverse((v) => !v)}>
              Reverse
            </Button>
          ) : null}
        </div>
      </div>

      <ErrorBanner error={post.error ?? reverse.error} />

      {showReverse ? (
        <Card title="Reverse this entry">
          <p className="mb-2 text-sm text-slate-600">
            A posted entry is never edited. Reversing posts the mirror image and links the two.
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Reason">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              </Field>
            </div>
            <Button
              variant="danger"
              onClick={() => reverse.mutate()}
              disabled={!reason || reverse.isPending}
            >
              {reverse.isPending ? 'Reversing…' : 'Post reversal'}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Date</dt>
            <dd>{entry.entryDate}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Source</dt>
            <dd>{entry.sourceModule}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Posted at</dt>
            <dd>{entry.postedAt ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Memo</dt>
            <dd>{entry.memo ?? '—'}</dd>
          </div>
          {entry.reversedByEntryId ? (
            <div className="sm:col-span-4">
              <dt className="text-xs text-slate-500">Reversed by</dt>
              <dd>
                <Link href={`/journal/${entry.reversedByEntryId}`} className="underline">
                  view reversing entry
                </Link>
              </dd>
            </div>
          ) : null}
          {entry.reversesEntryId ? (
            <div className="sm:col-span-4">
              <dt className="text-xs text-slate-500">Reverses</dt>
              <dd>
                <Link href={`/journal/${entry.reversesEntryId}`} className="underline">
                  view original entry
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>

      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Debit</th>
              <th className="px-3 py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-1.5 text-xs text-slate-400">{line.lineNo}</td>
                <td className="px-3 py-1.5">
                  <Link href={`/reports/general-ledger?accountId=${line.accountId}`} className="underline">
                    <span className="font-mono text-xs">{line.accountCode}</span> {line.accountName}
                  </Link>
                </td>
                <td className="px-3 py-1.5 text-slate-600">{line.description ?? ''}</td>
                <td className="px-3 py-1.5 text-right">
                  {line.side === 'debit' ? <Money value={line.amount} /> : null}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {line.side === 'credit' ? <Money value={line.amount} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-slate-300 bg-slate-50">
            <tr>
              <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase text-slate-600">
                Totals
              </td>
              <td className="px-3 py-2 text-right">
                <Money value={entry.totalDebit} bold />
              </td>
              <td className="px-3 py-2 text-right">
                <Money value={entry.totalCredit} bold />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
