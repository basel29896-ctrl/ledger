'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { JournalEntryDto } from '@acct/shared';
import { api } from '../../lib/api';
import { useSession, can } from '../../lib/session';
import {
  Badge,
  Button,
  DataTable,
  LoadingRow,
  Money,
  PageHeader,
  THead,
  Td,
  Th,
  Tr,
} from '../../components/ui';

const STATUS_TONE = {
  draft: 'warn',
  posted: 'good',
  reversed: 'neutral',
  void: 'bad',
} as const;

export default function JournalPage() {
  const { data: session } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ['journal-entries'],
    queryFn: () =>
      api.get<{ items: JournalEntryDto[]; nextCursor: string | null }>('/journal-entries?limit=50'),
  });

  return (
    <>
      <PageHeader
        title="Journal"
        subtitle="Posted entries are immutable; corrections are reversals."
        actions={
          can(session, 'ledger.entry.draft') ? (
            <Link href="/journal/new">
              <Button>New entry</Button>
            </Link>
          ) : null
        }
      />

      <DataTable scroll>
        <THead>
          <tr>
            <Th className="w-32">Reference</Th>
            <Th className="w-28">Date</Th>
            <Th>Memo</Th>
            <Th className="w-28">Source</Th>
            <Th numeric className="w-40">
              Debit
            </Th>
            <Th numeric className="w-40">
              Credit
            </Th>
            <Th className="w-24">Status</Th>
          </tr>
        </THead>
        <tbody>
          {isLoading ? (
            <LoadingRow colSpan={7} />
          ) : data?.items.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-10 text-center text-sm text-ink-400">
                No entries yet.
              </td>
            </tr>
          ) : (
            data?.items.map((entry) => (
              <Tr key={entry.id}>
                <Td mono>
                  <Link
                    href={`/journal/${entry.id}`}
                    className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                  >
                    {entry.entryRef ?? '(draft)'}
                  </Link>
                </Td>
                <Td mono muted>
                  {entry.entryDate}
                </Td>
                <Td>{entry.memo ?? ''}</Td>
                <Td muted className="text-xs capitalize">
                  {entry.sourceModule}
                </Td>
                <Td numeric>
                  <Money value={entry.totalDebit} />
                </Td>
                <Td numeric>
                  <Money value={entry.totalCredit} />
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[entry.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
                    {entry.status}
                  </Badge>
                </Td>
              </Tr>
            ))
          )}
        </tbody>
      </DataTable>
    </>
  );
}
