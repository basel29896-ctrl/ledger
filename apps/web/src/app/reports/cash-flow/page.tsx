'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CashFlowStatement, EquityStatement } from '@acct/domain';
import { api, API_URL } from '../../../lib/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Money,
  PageHeader,
  Stat,
  StatusNote,
  Toolbar,
} from '../../../components/ui';
import { SectionRows, StatementTable, TotalRow } from '../../../components/statement-table';

export default function CashFlowPage() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const ready = fromDate !== '' && toDate !== '';
  const range = `fromDate=${fromDate}&toDate=${toDate}`;

  const cashFlow = useQuery({
    queryKey: ['cash-flow', fromDate, toDate],
    queryFn: () => api.get<CashFlowStatement>(`/reports/cash-flow?${range}`),
    enabled: ready,
  });
  const equity = useQuery({
    queryKey: ['equity-statement', fromDate, toDate],
    queryFn: () => api.get<EquityStatement>(`/reports/equity?${range}`),
    enabled: ready,
  });

  const data = cashFlow.data;

  return (
    <>
      <PageHeader
        title="Cash Flow and Equity"
        subtitle="Indirect method. The three sections must sum to the movement in cash."
        actions={
          <Button
            variant="secondary"
            disabled={!ready}
            onClick={() => {
              window.location.href = `${API_URL}/api/v1/reports/cash-flow?${range}&format=csv`;
            }}
          >
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
      </Toolbar>

      <ErrorBanner error={cashFlow.error ?? equity.error} />

      {!ready ? (
        <EmptyState>Choose a date range.</EmptyState>
      ) : data ? (
        <>
          <Card title="Reconciliation to the bank">
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Opening cash" value={<Money value={data.openingCash} />} />
              <Stat label="Net movement" value={<Money value={data.netMovement} />} />
              <Stat label="Closing cash" value={<Money value={data.closingCash} bold />} />
            </div>
          </Card>

          <StatusNote tone={data.reconciles ? 'good' : 'bad'}>
            {data.reconciles
              ? 'Operating, investing and financing tie to the movement in the cash and bank accounts.'
              : 'The statement does not tie to the bank — investigate before relying on it.'}
          </StatusNote>

          <StatementTable>
            <TotalRow label="Profit for the period" value={data.operating.netProfit} />
            <SectionRows section={data.operating.nonCashAdjustments} fromDate={fromDate} toDate={toDate} />
            <SectionRows section={data.operating.workingCapital} fromDate={fromDate} toDate={toDate} />
            <TotalRow label="Cash from operating activities" value={data.operating.total} />
            <SectionRows section={data.investing} fromDate={fromDate} toDate={toDate} />
            <SectionRows section={data.financing} fromDate={fromDate} toDate={toDate} />
            <TotalRow
              label={`Net movement in cash (${data.currency})`}
              value={data.netMovement}
              emphasis="strong"
            />
          </StatementTable>

          {equity.data ? (
            <Card title="Changes in equity" padded={false}>
              <StatementTable>
                <TotalRow label="Opening equity" value={equity.data.openingEquity} />
                <SectionRows section={equity.data.movements} fromDate={fromDate} toDate={toDate} />
                <TotalRow label="Profit for the period" value={equity.data.profitForPeriod} />
                <TotalRow label="Closing equity" value={equity.data.closingEquity} emphasis="strong" />
              </StatementTable>
            </Card>
          ) : null}
        </>
      ) : (
        <EmptyState>Loading…</EmptyState>
      )}
    </>
  );
}
