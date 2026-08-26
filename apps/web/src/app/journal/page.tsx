'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { JournalEntryDto } from '@acct/shared';
import { api } from '../../lib/api';
import { useSession, can } from '../../lib/session';
import { Button, Money } from '../../components/ui';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-amber-100 text-amber-900',
  posted: 'bg-green-100 text-green-900',
  reversed: 'bg-slate-200 text-slate-700',
  void: 'bg-red-100 text-red-900',
};

export default function JournalPage() {
  const { data: session } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ['journal-entries'],
    queryFn: () =>
      api.get<{ items: JournalEntryDto[]; nextCursor: string | null }>('/journal-entries?limit=50'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Journal</h1>
        {can(session, 'ledger.entry.draft') ? (
          <Link href="/journal/new" className="ml-auto">
            <Button>New entry</Button>
          </Link>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Reference</th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Memo</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 text-right font-medium">Debit</th>
              <th className="px-3 py-2 text-right font-medium">Credit</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : data?.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  No entries yet.
                </td>
              </tr>
            ) : (
              data?.items.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono text-xs">
                    <Link href={`/journal/${entry.id}`} className="text-slate-900 underline">
                      {entry.entryRef ?? '(draft)'}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">{entry.entryDate}</td>
                  <td className="px-3 py-1.5 text-slate-700">{entry.memo ?? ''}</td>
                  <td className="px-3 py-1.5 text-slate-500">{entry.sourceModule}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Money value={entry.totalDebit} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Money value={entry.totalCredit} />
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[entry.status] ?? ''}`}>
                      {entry.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
