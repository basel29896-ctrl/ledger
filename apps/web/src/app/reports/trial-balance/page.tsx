'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { TrialBalanceDto } from '@acct/shared';
import { api } from '../../../lib/api';
import {
  Button,
  DataTable,
  Field,
  Input,
  LoadingRow,
  Money,
  PageHeader,
  StatusNote,
  TFoot,
  THead,
  Td,
  Th,
  Toolbar,
  Tr,
} from '../../../components/ui';

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

  const range = `${fromDate ? `&fromDate=${fromDate}` : ''}${toDate ? `&toDate=${toDate}` : ''}`;

  return (
    <>
      <PageHeader
        title="Trial Balance"
        subtitle="Computed from journal lines, never from the balance cache."
        actions={
          <Button variant="secondary" onClick={exportCsv} disabled={!data}>
            Export CSV
          </Button>
        }
      />

      <Toolbar>
        <Field label="From date">
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field label="To date">
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </Field>
        <label className="flex h-8 items-center gap-2 self-end text-sm text-ink-600">
          <input
            type="checkbox"
            checked={includeZero}
            onChange={(e) => setIncludeZero(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-ice-300"
          />
          Include zero balances
        </label>
      </Toolbar>

      {data ? (
        <StatusNote tone={data.balanced ? 'good' : 'bad'}>
          {data.balanced
            ? 'Debits equal credits. The books balance.'
            : `OUT OF BALANCE by ${data.difference.amount} ${data.currency}. This is a P1 incident — run make ledger:verify.`}
        </StatusNote>
      ) : null}

      <DataTable scroll>
        <THead>
          <tr>
            <Th className="w-24">Code</Th>
            <Th>Account</Th>
            <Th className="w-32">Type</Th>
            <Th numeric className="w-40">
              Debit
            </Th>
            <Th numeric className="w-40">
              Credit
            </Th>
            <Th numeric className="w-40">
              Balance
            </Th>
          </tr>
        </THead>
        <tbody>
          {isLoading ? (
            <LoadingRow colSpan={6} />
          ) : (
            data?.rows.map((row) => (
              <Tr key={row.accountId}>
                <Td mono muted>
                  {row.accountCode}
                </Td>
                <Td>
                  {/* Every number drills to its source in one click. */}
                  <Link
                    href={`/reports/general-ledger?accountId=${row.accountId}${range}`}
                    className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                  >
                    {row.accountName}
                  </Link>
                </Td>
                <Td muted className="text-xs capitalize">
                  {row.accountType}
                </Td>
                <Td numeric>
                  <Money value={row.debitTotal} />
                </Td>
                <Td numeric>
                  <Money value={row.creditTotal} />
                </Td>
                <Td numeric>
                  <Money value={row.closingBalance} />
                </Td>
              </Tr>
            ))
          )}
        </tbody>
        {data ? (
          <TFoot>
            <tr>
              <Td colSpan={3} className="text-end text-[11px] uppercase tracking-wider text-ink-500">
                Totals ({data.currency})
              </Td>
              <Td numeric>
                <Money value={data.totalDebit} bold />
              </Td>
              <Td numeric>
                <Money value={data.totalCredit} bold />
              </Td>
              <Td numeric>
                <Money value={data.difference} bold />
              </Td>
            </tr>
          </TFoot>
        ) : null}
      </DataTable>
    </>
  );
}
