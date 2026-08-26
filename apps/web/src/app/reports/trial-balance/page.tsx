'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { TrialBalanceDto } from '@acct/shared';
import { api } from '../../../lib/api';
import { Button, Card, Field, Input, Money } from '../../../components/ui';

export default function TrialBalancePage() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [includeZero, setIncludeZero] = useState(false);

  const query = new URLSearchParams();
  if (fromDate) query.set('fromDate', fromDate);
  if (toDate) query.set('toDate', toDate);
  if (includeZero) query.set('includeZeroBalances', 'true');

  const { data, isLoading } = useQuery({
    queryKey: ['trial-balance', fromDate, toDate, includeZero],
    queryFn: () => api.get<TrialBalanceDto>(`/reports/trial-balance?${query.toString()}`),
  });

  const exportCsv = (): void => {
    if (!data) return;
    const header = 'code,name,type,debit,credit,closing_balance,currency';
    const rows = data.rows.map((r) =>
      [
        r.accountCode,
        `"${r.accountName.replace(/"/g, '""')}"`,
        r.accountType,
        r.debitTotal.amount,
        r.creditTotal.amount,
        r.closingBalance.amount,
        data.currency,
      ].join(','),
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `trial-balance-${toDate || 'all'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Trial Balance</h1>
        <Button variant="secondary" className="ml-auto" onClick={exportCsv} disabled={!data}>
          Export CSV
        </Button>
      </div>

      <Card>
        <div className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="From date">
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </Field>
          <Field label="To date">
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 pb-1 text-sm">
            <input
              type="checkbox"
              checked={includeZero}
              onChange={(e) => setIncludeZero(e.target.checked)}
            />
            Include zero balances
          </label>
        </div>
      </Card>

      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Code</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Debit</th>
              <th className="px-3 py-2 text-right font-medium">Credit</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : (
              data?.rows.map((row) => (
                <tr key={row.accountId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono text-xs">{row.accountCode}</td>
                  <td className="px-3 py-1.5">
                    {/* Every number drills to its source in one click. */}
                    <Link
                      href={`/reports/general-ledger?accountId=${row.accountId}${
                        fromDate ? `&fromDate=${fromDate}` : ''
                      }${toDate ? `&toDate=${toDate}` : ''}`}
                      className="underline"
                    >
                      {row.accountName}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{row.accountType}</td>
                  <td className="px-3 py-1.5 text-right"><Money value={row.debitTotal} /></td>
                  <td className="px-3 py-1.5 text-right"><Money value={row.creditTotal} /></td>
                  <td className="px-3 py-1.5 text-right"><Money value={row.closingBalance} /></td>
                </tr>
              ))
            )}
          </tbody>
          {data ? (
            <tfoot className="border-t border-slate-300 bg-slate-50">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase text-slate-600">
                  Totals ({data.currency})
                </td>
                <td className="px-3 py-2 text-right"><Money value={data.totalDebit} bold /></td>
                <td className="px-3 py-2 text-right"><Money value={data.totalCredit} bold /></td>
                <td className="px-3 py-2 text-right"><Money value={data.difference} bold /></td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {data ? (
        <p className={`text-sm ${data.balanced ? 'text-green-700' : 'text-red-700'}`}>
          {data.balanced
            ? 'Debits equal credits. The books balance.'
            : `OUT OF BALANCE by ${data.difference.amount} ${data.currency}. This is a P1 incident — run make ledger:verify.`}
        </p>
      ) : null}
    </div>
  );
}
