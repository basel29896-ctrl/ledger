'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { TrialBalanceDto } from '@acct/shared';
import { api } from '../lib/api';
import { Card, Money } from '../components/ui';

export default function Home() {
  const { data: tb } = useQuery({
    queryKey: ['trial-balance', 'summary'],
    queryFn: () => api.get<TrialBalanceDto>('/reports/trial-balance'),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Overview</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Trial balance">
          {tb ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Debits</span>
                <Money value={tb.totalDebit} />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Credits</span>
                <Money value={tb.totalCredit} />
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1">
                <span className="text-slate-600">Difference</span>
                <Money value={tb.difference} bold />
              </div>
              <p className={`pt-1 text-xs ${tb.balanced ? 'text-green-700' : 'text-red-700'}`}>
                {tb.balanced ? 'The books balance.' : 'OUT OF BALANCE — investigate immediately.'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
        </Card>

        <Card title="Post an entry">
          <p className="text-sm text-slate-600">
            Manual journal entries with a live out-of-balance indicator.
          </p>
          <Link href="/journal/new" className="mt-2 inline-block text-sm text-slate-900 underline">
            New journal entry
          </Link>
        </Card>

        <Card title="Accounts">
          <p className="text-sm text-slate-600">The chart of accounts and its hierarchy.</p>
          <Link href="/accounts" className="mt-2 inline-block text-sm text-slate-900 underline">
            Open chart of accounts
          </Link>
        </Card>
      </div>
    </div>
  );
}
