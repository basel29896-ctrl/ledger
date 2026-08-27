'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JournalEntryDto } from '@acct/shared';
import { api } from '../../../lib/api';
import { useSession, can } from '../../../lib/session';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Money,
  PageHeader,
  TFoot,
  THead,
  Td,
  Th,
  Tr,
} from '../../../components/ui';

const STATUS_TONE = {
  draft: 'warn',
  posted: 'good',
  reversed: 'neutral',
  void: 'bad',
} as const;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-ink-800">{children}</dd>
    </div>
  );
}

export function EntryDetail() {
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

  if (isLoading) return <EmptyState>Loading…</EmptyState>;
  if (!entry) return <EmptyState>Not found.</EmptyState>;

  return (
    <>
      <PageHeader
        title={entry.entryRef ?? 'Draft entry'}
        subtitle={`${entry.entryDate} · ${entry.sourceModule}`}
        actions={
          <>
            <Badge tone={STATUS_TONE[entry.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
              {entry.status}
            </Badge>
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
          </>
        }
      />

      <ErrorBanner error={post.error ?? reverse.error} />

      {showReverse ? (
        <Card title="Reverse this entry">
          <p className="mb-3 text-sm text-ink-500">
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
        <dl className="grid gap-4 text-sm sm:grid-cols-4">
          <Detail label="Date">{entry.entryDate}</Detail>
          <Detail label="Source">
            <span className="capitalize">{entry.sourceModule}</span>
          </Detail>
          <Detail label="Posted at">{entry.postedAt ?? '—'}</Detail>
          <Detail label="Memo">{entry.memo ?? '—'}</Detail>
          {entry.reversedByEntryId ? (
            <div className="sm:col-span-4">
              <Detail label="Reversed by">
                <Link
                  href={`/journal/${entry.reversedByEntryId}`}
                  className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                >
                  view reversing entry
                </Link>
              </Detail>
            </div>
          ) : null}
          {entry.reversesEntryId ? (
            <div className="sm:col-span-4">
              <Detail label="Reverses">
                <Link
                  href={`/journal/${entry.reversesEntryId}`}
                  className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                >
                  view original entry
                </Link>
              </Detail>
            </div>
          ) : null}
        </dl>
      </Card>

      <DataTable>
        <THead>
          <tr>
            <Th className="w-10">#</Th>
            <Th>Account</Th>
            <Th>Description</Th>
            <Th numeric className="w-40">
              Debit
            </Th>
            <Th numeric className="w-40">
              Credit
            </Th>
          </tr>
        </THead>
        <tbody>
          {entry.lines.map((line) => (
            <Tr key={line.id}>
              <Td muted className="text-xs">
                {line.lineNo}
              </Td>
              <Td>
                <Link
                  href={`/reports/general-ledger?accountId=${line.accountId}`}
                  className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                >
                  <span className="font-mono text-xs text-ink-400">{line.accountCode}</span>{' '}
                  {line.accountName}
                </Link>
              </Td>
              <Td muted>{line.description ?? ''}</Td>
              <Td numeric>{line.side === 'debit' ? <Money value={line.amount} /> : null}</Td>
              <Td numeric>{line.side === 'credit' ? <Money value={line.amount} /> : null}</Td>
            </Tr>
          ))}
        </tbody>
        <TFoot>
          <tr>
            <Td colSpan={3} className="text-end text-[11px] uppercase tracking-wider text-ink-500">
              Totals
            </Td>
            <Td numeric>
              <Money value={entry.totalDebit} bold />
            </Td>
            <Td numeric>
              <Money value={entry.totalCredit} bold />
            </Td>
          </tr>
        </TFoot>
      </DataTable>
    </>
  );
}
