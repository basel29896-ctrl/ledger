'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CashFlowStatement, EquityStatement } from '@acct/domain';
import { api, API_URL } from '../../../lib/api';
import { Button, Card, ErrorBanner, Field, Input, Money } from '../../../components/ui';
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
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Cash Flow and Equity</h1>
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={!ready}
          onClick={() => {
            window.location.href = `${API_URL}/api/v1/reports/cash-flow?${range}&format=csv`;
          }}
        >
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
        </div>
      </Card>

      <ErrorBanner error={cashFlow.error ?? equity.error} />

      {!ready ? (
        <p className="text-sm text-slate-500">Choose a date range.</p>
      ) : data ? (
        <>
          <StatementTable>
            <TotalRow label="Profit for the period" value={data.operating.netProfit} />
            <SectionRows section={data.operating.nonCashAdjustments} fromDate={fromDate} toDate={toDate} />
            <SectionRows section={data.operating.workingCapital} fromDate={fromDate} toDate={toDate} />
            <TotalRow label="Cash from operating activities" value={data.operating.total} />
            <SectionRows section={data.investing} fromDate={fromDate} toDate={toDate} />
            <SectionRows section={data.financing} fromDate={fromDate} toDate={toDate} />
            <TotalRow label={`Net movement in cash (${data.currency})`} value={data.netMovement} />
          </StatementTable>

          <Card title="Reconciliation to the bank">
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs uppercase text-slate-600">Opening cash</dt>
                <dd><Money value={data.openingCash} /></dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-600">Net movement</dt>
                <dd><Money value={data.netMovement} /></dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-600">Closing cash</dt>
                <dd><Money value={data.closingCash} bold /></dd>
              </div>
            </dl>
          </Card>

          {equity.data ? (
            <Card title="Changes in equity">
              <StatementTable>
                <TotalRow label="Opening equity" value={equity.data.openingEquity} />
                <SectionRows section={equity.data.movements} fromDate={fromDate} toDate={toDate} />
                <TotalRow label="Profit for the period" value={equity.data.profitForPeriod} />
                <TotalRow label="Closing equity" value={equity.data.closingEquity} />
              </StatementTable>
            </Card>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
    </div>
  );
}
