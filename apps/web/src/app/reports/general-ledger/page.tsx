'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { AccountDto, MoneyDto } from '@acct/shared';
import { api } from '../../../lib/api';
import {
  Card,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  Select,
  Stat,
  TFoot,
  THead,
  Td,
  Th,
  Toolbar,
  Tr,
} from '../../../components/ui';
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
    <>
      <PageHeader
        title="General Ledger"
        subtitle="Every posted line hitting one account, in date order, with a running balance."
        actions={
          <Link
            href="/reports/trial-balance"
            className="text-sm text-ink-600 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
          >
            back to trial balance
          </Link>
        }
      />

      <Toolbar>
        <div className="sm:col-span-2">
          <Select
            aria-label="Account"
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
      </Toolbar>

      {!accountId ? (
        <EmptyState>Choose an account to see its detail.</EmptyState>
      ) : isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : data ? (
        <>
          <Card>
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat
                label="Account"
                value={
                  <span className="text-base">
                    <span className="font-mono text-xs text-ink-400">{data.accountCode}</span>{' '}
                    {data.accountName}
                  </span>
                }
              />
              <Stat label="Opening balance" value={<Money value={data.openingBalance} />} />
              <Stat label="Closing balance" value={<Money value={data.closingBalance} bold />} />
            </div>
          </Card>

          <DataTable scroll>
            <THead>
              <tr>
                <Th className="w-28">Date</Th>
                <Th className="w-32">Reference</Th>
                <Th>Description</Th>
                <Th className="w-28">Source</Th>
                <Th numeric className="w-36">
                  Debit
                </Th>
                <Th numeric className="w-36">
                  Credit
                </Th>
                <Th numeric className="w-40">
                  Balance
                </Th>
              </tr>
            </THead>
            <tbody>
              <tr className="border-b border-ice-200 bg-ice-50">
                <Td colSpan={6} className="text-[11px] uppercase tracking-wider text-ink-500">
                  Opening balance
                </Td>
                <Td numeric>
                  <Money value={data.openingBalance} />
                </Td>
              </tr>
              {data.rows.map((row, index) => (
                <Tr key={`${row.entryId}-${index}`}>
                  <Td mono muted>
                    {row.entryDate}
                  </Td>
                  <Td mono>
                    {/* One click from a report figure to its source document. */}
                    <Link
                      href={`/journal/${row.entryId}`}
                      className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                    >
                      {row.entryRef ?? 'view'}
                    </Link>
                  </Td>
                  <Td>{row.lineDescription ?? row.memo ?? ''}</Td>
                  <Td muted className="text-xs capitalize">
                    {row.sourceModule}
                  </Td>
                  <Td numeric>{row.debit.minor === '0' ? null : <Money value={row.debit} />}</Td>
                  <Td numeric>{row.credit.minor === '0' ? null : <Money value={row.credit} />}</Td>
                  <Td numeric>
                    <Money value={row.runningBalance} />
                  </Td>
                </Tr>
              ))}
            </tbody>
            <TFoot>
              <tr>
                <Td colSpan={4} className="text-end text-[11px] uppercase tracking-wider text-ink-500">
                  Totals ({data.currency})
                </Td>
                <Td numeric>
                  <Money value={data.totalDebit} bold />
                </Td>
                <Td numeric>
                  <Money value={data.totalCredit} bold />
                </Td>
                <Td numeric>
                  <Money value={data.closingBalance} bold />
                </Td>
              </tr>
            </TFoot>
          </DataTable>
        </>
      ) : null}
    </>
  );
}

export default function GeneralLedgerPage() {
  return (
    <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
      <GeneralLedgerContent />
    </Suspense>
  );
}
