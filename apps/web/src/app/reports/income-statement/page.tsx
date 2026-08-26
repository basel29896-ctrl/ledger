'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IncomeStatement } from '@acct/domain';
import { api, API_URL } from '../../../lib/api';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Money,
  PageHeader,
  THead,
  Td,
  Th,
  Toolbar,
  Tr,
} from '../../../components/ui';
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
    <>
      <PageHeader
        title="Income Statement"
        subtitle="Built from posted journal lines for the window."
        actions={
          <Button
            variant="secondary"
            disabled={!ready}
            onClick={() => {
              // The API renders the CSV so the export carries the same figures.
              window.location.href = `${API_URL}/api/v1/reports/income-statement?${params.toString()}&format=csv`;
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
        <Field label="Compare from" hint="Optional prior period">
          <Input
            type="date"
            value={compareFromDate}
            onChange={(e) => setCompareFromDate(e.target.value)}
          />
        </Field>
        <Field label="Compare to">
          <Input type="date" value={compareToDate} onChange={(e) => setCompareToDate(e.target.value)} />
        </Field>
      </Toolbar>

      <ErrorBanner error={error} />

      {!ready ? (
        <EmptyState>Choose a date range to build the statement.</EmptyState>
      ) : isFetching && !data ? (
        <EmptyState>Loading…</EmptyState>
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
            <TotalRow
              label={`Profit for the period (${data.currency})`}
              value={data.netProfit}
              emphasis="strong"
            />
          </StatementTable>

          {data.comparative && data.variance ? (
            <Card title="Against the comparative period" padded={false}>
              <DataTable className="rounded-none border-0">
                <THead>
                  <tr>
                    <Th>Measure</Th>
                    <Th numeric className="w-44">
                      This period
                    </Th>
                    <Th numeric className="w-44">
                      Comparative
                    </Th>
                    <Th numeric className="w-44">
                      Variance
                    </Th>
                  </tr>
                </THead>
                <tbody>
                  {(
                    [
                      ['Revenue', data.revenue.total, data.comparative.revenue.total, data.variance.revenue],
                      [
                        'Gross profit',
                        data.grossProfit,
                        data.comparative.grossProfit,
                        data.variance.grossProfit,
                      ],
                      ['Net profit', data.netProfit, data.comparative.netProfit, data.variance.netProfit],
                    ] as const
                  ).map(([label, current, prior, variance]) => (
                    <Tr key={label}>
                      <Td>{label}</Td>
                      <Td numeric>
                        <Money value={current} />
                      </Td>
                      <Td numeric>
                        <Money value={prior} />
                      </Td>
                      <Td numeric>
                        <Money value={variance} bold />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
