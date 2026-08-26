'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BalanceSheet } from '@acct/domain';
import { api, API_URL } from '../../../lib/api';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  StatusNote,
  Toolbar,
} from '../../../components/ui';
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
    <>
      <PageHeader
        title="Balance Sheet"
        subtitle="Assets, liabilities and equity, including the unclosed profit for the year."
        actions={
          <Button
            variant="secondary"
            disabled={!ready}
            onClick={() => {
              window.location.href = `${API_URL}/api/v1/reports/balance-sheet?asOfDate=${asOfDate}&format=csv`;
            }}
          >
            Export CSV
          </Button>
        }
      />

      <Toolbar>
        <Field label="As at" hint="The statement covers the fiscal year to this date">
          <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </Field>
      </Toolbar>

      <ErrorBanner error={error} />

      {!ready ? (
        <EmptyState>Choose a date.</EmptyState>
      ) : isFetching && !data ? (
        <EmptyState>Loading…</EmptyState>
      ) : data ? (
        <>
          <StatementTable>
            <SectionRows section={data.currentAssets} toDate={asOfDate} />
            <SectionRows section={data.nonCurrentAssets} toDate={asOfDate} />
            <TotalRow label={`Total assets (${data.currency})`} value={data.totalAssets} emphasis="strong" />
            <SectionRows section={data.currentLiabilities} toDate={asOfDate} />
            <SectionRows section={data.nonCurrentLiabilities} toDate={asOfDate} />
            <TotalRow label="Total liabilities" value={data.totalLiabilities} />
            <SectionRows section={data.equity} toDate={asOfDate} />
            <TotalRow
              label="Total liabilities and equity"
              value={data.totalLiabilitiesAndEquity}
              emphasis="strong"
            />
          </StatementTable>

          <StatusNote tone="good">
            Assets equal liabilities plus equity. A statement that did not balance would be refused by
            the API rather than shown here.
          </StatusNote>
        </>
      ) : null}
    </>
  );
}
