'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { AccountDto, MoneyDto } from '@acct/shared';
import { api } from '../../../lib/api';
import { Card, Money, Select } from '../../../components/ui';
import { useRouter } from 'next/navigation';

interface GeneralLedgerRow {
  entryId: string;
  entryRef: string | null;
  entryDate: string;
  memo: string | null;
  lineDescription: string | null;
  debit: MoneyDto;
  credit: MoneyDto;
  runningBalance: MoneyDto;
  sourceModule: string;
  status: string;
}

interface GeneralLedgerReport {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  currency: string;
  openingBalance: MoneyDto;
  closingBalance: MoneyDto;
  totalDebit: MoneyDto;
  totalCredit: MoneyDto;
  rows: GeneralLedgerRow[];
}

function GeneralLedgerContent() {
  const params = useSearchParams();
  const router = useRouter();
  const accountId = params.get('accountId') ?? '';
  const fromDate = params.get('fromDate') ?? '';
  const toDate = params.get('toDate') ?? '';

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<AccountDto[]>('/accounts'),
  });

  const query = new URLSearchParams();
  if (fromDate) query.set('fromDate', fromDate);
  if (toDate) query.set('toDate', toDate);

  const { data, isLoading } = useQuery({
    queryKey: ['general-ledger', accountId, fromDate, toDate],
    queryFn: () =>
      api.get<GeneralLedgerReport>(`/reports/general-ledger/${accountId}?${query.toString()}`),
    enabled: Boolean(accountId),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">General Ledger</h1>
        <Link href="/reports/trial-balance" className="ml-auto text-sm underline">
          back to trial balance
        </Link>
      </div>

      <Card>
        <div className="max-w-md">
          <Select
            value={accountId}
            onChange={(e) => router.push(`/reports/general-ledger?accountId=${e.target.value}`)}
          >
            <option value="">— select an account —</option>
            {accounts
              .filter((a) => a.isPostable)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
          </Select>
        </div>
      </Card>

      {!accountId ? (
        <p className="text-sm text-slate-500">Choose an account to see its detail.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : data ? (
        <>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-xs text-slate-500">Account</span>
              <div className="font-medium">
                <span className="font-mono text-xs">{data.accountCode}</span> {data.accountName}
              </div>
            </div>
            <div>
              <span className="text-xs text-slate-500">Opening</span>
              <div><Money value={data.openingBalance} /></div>
            </div>
            <div>
              <span className="text-xs text-slate-500">Closing</span>
              <div><Money value={data.closingBalance} bold /></div>
            </div>
          </div>

          <div className="overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 text-right font-medium">Debit</th>
                  <th className="px-3 py-2 text-right font-medium">Credit</th>
                  <th className="px-3 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <td colSpan={6} className="px-3 py-1.5 text-xs uppercase text-slate-500">
                    Opening balance
                  </td>
                  <td className="px-3 py-1.5 text-right"><Money value={data.openingBalance} /></td>
                </tr>
                {data.rows.map((row, index) => (
                  <tr
                    key={`${row.entryId}-${index}`}
                    className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-3 py-1.5">{row.entryDate}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {/* One click from a report figure to its source document. */}
                      <Link href={`/journal/${row.entryId}`} className="underline">
                        {row.entryRef ?? 'view'}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-slate-700">
                      {row.lineDescription ?? row.memo ?? ''}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">{row.sourceModule}</td>
                    <td className="px-3 py-1.5 text-right">
                      {row.debit.minor === '0' ? null : <Money value={row.debit} />}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {row.credit.minor === '0' ? null : <Money value={row.credit} />}
                    </td>
                    <td className="px-3 py-1.5 text-right"><Money value={row.runningBalance} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-300 bg-slate-50">
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-right text-xs uppercase text-slate-600">
                    Totals ({data.currency})
                  </td>
                  <td className="px-3 py-2 text-right"><Money value={data.totalDebit} bold /></td>
                  <td className="px-3 py-2 text-right"><Money value={data.totalCredit} bold /></td>
                  <td className="px-3 py-2 text-right"><Money value={data.closingBalance} bold /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function GeneralLedgerPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <GeneralLedgerContent />
    </Suspense>
  );
}
