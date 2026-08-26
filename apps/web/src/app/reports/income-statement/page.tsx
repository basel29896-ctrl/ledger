'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IncomeStatement } from '@acct/domain';
import { api, API_URL } from '../../../lib/api';
import { Button, Card, ErrorBanner, Field, Input, Money } from '../../../components/ui';
import { SectionRows, StatementTable, TotalRow } from '../../../components/statement-table';

export default function IncomeStatementPage() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [compareFromDate, setCompareFromDate] = useState('');
  const [compareToDate, setCompareToDate] = useState('');

  const params = new URLSearchParams({ fromDate, toDate });
  if (compareFromDate && compareToDate) {
    params.set('compareFromDate', compareFromDate);
    params.set('compareToDate', compareToDate);
  }

  const ready = fromDate !== '' && toDate !== '';
  const { data, error, isFetching } = useQuery({
    queryKey: ['income-statement', params.toString()],
    queryFn: () => api.get<IncomeStatement>(`/reports/income-statement?${params.toString()}`),
    enabled: ready,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Income Statement</h1>
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={!ready}
          onClick={() => {
            // The API renders the CSV so the export carries the same figures.
            window.location.href = `${API_URL}/api/v1/reports/income-statement?${params.toString()}&format=csv`;
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
          <Field label="Compare from" hint="Optional prior period">
            <Input type="date" value={compareFromDate} onChange={(e) => setCompareFromDate(e.target.value)} />
          </Field>
          <Field label="Compare to">
            <Input type="date" value={compareToDate} onChange={(e) => setCompareToDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      <ErrorBanner error={error} />

      {!ready ? (
        <p className="text-sm text-slate-500">Choose a date range.</p>
      ) : isFetching && !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : data ? (
        <>
          <StatementTable>
            <SectionRows section={data.revenue} fromDate={fromDate} toDate={toDate} />
            <SectionRows section={data.costOfSales} fromDate={fromDate} toDate={toDate} />
            <TotalRow label="Gross profit" value={data.grossProfit} />
            <SectionRows section={data.operatingExpenses} fromDate={fromDate} toDate={toDate} />
            <TotalRow label="Operating profit" value={data.operatingProfit} />
            <SectionRows section={data.otherIncome} fromDate={fromDate} toDate={toDate} />
            <SectionRows section={data.otherExpenses} fromDate={fromDate} toDate={toDate} />
            <TotalRow label={`Profit for the period (${data.currency})`} value={data.netProfit} />
          </StatementTable>

          {data.comparative && data.variance ? (
            <Card title="Against the comparative period">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Measure</th>
                    <th className="px-3 py-1.5 text-right font-medium">This period</th>
                    <th className="px-3 py-1.5 text-right font-medium">Comparative</th>
                    <th className="px-3 py-1.5 text-right font-medium">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Revenue', data.revenue.total, data.comparative.revenue.total, data.variance.revenue],
                      ['Gross profit', data.grossProfit, data.comparative.grossProfit, data.variance.grossProfit],
                      ['Net profit', data.netProfit, data.comparative.netProfit, data.variance.netProfit],
                    ] as const
                  ).map(([label, current, prior, variance]) => (
                    <tr key={label} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">{label}</td>
                      <td className="px-3 py-1.5 text-right"><Money value={current} /></td>
                      <td className="px-3 py-1.5 text-right"><Money value={prior} /></td>
                      <td className="px-3 py-1.5 text-right"><Money value={variance} bold /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
