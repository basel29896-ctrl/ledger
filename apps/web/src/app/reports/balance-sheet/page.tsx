'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BalanceSheet } from '@acct/domain';
import { api, API_URL } from '../../../lib/api';
import { Button, Card, ErrorBanner, Field, Input } from '../../../components/ui';
import { SectionRows, StatementTable, TotalRow } from '../../../components/statement-table';

export default function BalanceSheetPage() {
  const [asOfDate, setAsOfDate] = useState('');
  const ready = asOfDate !== '';

  const { data, error, isFetching } = useQuery({
    queryKey: ['balance-sheet', asOfDate],
    queryFn: () => api.get<BalanceSheet>(`/reports/balance-sheet?asOfDate=${asOfDate}`),
    enabled: ready,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Balance Sheet</h1>
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={!ready}
          onClick={() => {
            window.location.href = `${API_URL}/api/v1/reports/balance-sheet?asOfDate=${asOfDate}&format=csv`;
          }}
        >
          Export CSV
        </Button>
      </div>

      <Card>
        <div className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="As at" hint="The statement covers the fiscal year to this date">
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      <ErrorBanner error={error} />

      {!ready ? (
        <p className="text-sm text-slate-500">Choose a date.</p>
      ) : isFetching && !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : data ? (
        <>
          <StatementTable>
            <SectionRows section={data.currentAssets} toDate={asOfDate} />
            <SectionRows section={data.nonCurrentAssets} toDate={asOfDate} />
            <TotalRow label={`Total assets (${data.currency})`} value={data.totalAssets} />
            <SectionRows section={data.currentLiabilities} toDate={asOfDate} />
            <SectionRows section={data.nonCurrentLiabilities} toDate={asOfDate} />
            <TotalRow label="Total liabilities" value={data.totalLiabilities} />
            <SectionRows section={data.equity} toDate={asOfDate} />
            <TotalRow label="Total liabilities and equity" value={data.totalLiabilitiesAndEquity} />
          </StatementTable>
          <p className="text-sm text-green-700">
            Assets equal liabilities plus equity. A statement that did not balance would be refused
            by the API rather than shown here.
          </p>
        </>
      ) : null}
    </div>
  );
}
