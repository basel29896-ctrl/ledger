'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Money,
  PageHeader,
  Select,
  TFoot,
  THead,
  Td,
  Th,
  Toolbar,
  Tr,
} from '../../components/ui';

interface Budget {
  id: string;
  name: string;
  status: string;
  lineCount: number;
  total: { amount: string };
}

interface VarianceLine {
  accountId: string;
  code: string;
  name: string;
  budget: { amount: string };
  actual: { amount: string };
  variance: { amount: string };
  isFavourable: boolean | null;
  variancePercent: string | null;
}

interface VarianceReport {
  currency: string;
  lines: VarianceLine[];
  totalBudget: { amount: string };
  totalActual: { amount: string };
  totalVariance: { amount: string };
}

export default function BudgetPage() {
  const [budgetId, setBudgetId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const budgets = useQuery({ queryKey: ['budgets'], queryFn: () => api.get<Budget[]>('/budgets') });
  const selected = budgetId || budgets.data?.[0]?.id || '';
  const ready = selected !== '' && fromDate !== '' && toDate !== '';

  const variance = useQuery({
    queryKey: ['budget-variance', selected, fromDate, toDate],
    queryFn: () =>
      api.get<VarianceReport>(`/budgets/${selected}/variance?fromDate=${fromDate}&toDate=${toDate}`),
    enabled: ready,
  });

  return (
    <>
      <PageHeader
        title="Budget vs Actual"
        subtitle="Favourable follows the account type, not the sign of the variance."
      />

      <Toolbar>
        <Field label="Budget">
          <Select value={selected} onChange={(e) => setBudgetId(e.target.value)}>
            {budgets.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.status})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From date">
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field label="To date">
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </Field>
      </Toolbar>

      <ErrorBanner error={budgets.error ?? variance.error} />

      {!ready ? (
        <EmptyState>Choose a budget and a date range.</EmptyState>
      ) : variance.data ? (
        <DataTable scroll>
          <THead>
            <tr>
              <Th className="w-24">Code</Th>
              <Th>Account</Th>
              <Th numeric className="w-36">
                Budget
              </Th>
              <Th numeric className="w-36">
                Actual
              </Th>
              <Th numeric className="w-36">
                Variance
              </Th>
              <Th numeric className="w-24">
                %
              </Th>
            </tr>
          </THead>
          <tbody>
            {variance.data.lines.map((line) => (
              <Tr key={line.accountId}>
                <Td mono muted>
                  {line.code}
                </Td>
                <Td>
                  <a
                    href={`/reports/general-ledger?accountId=${line.accountId}`}
                    className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                  >
                    {line.name}
                  </a>
                </Td>
                <Td numeric>
                  <Money value={line.budget} />
                </Td>
                <Td numeric>
                  <Money value={line.actual} />
                </Td>
                {/* Colour reads the account type, so a cost overrun is never green. */}
                <Td
                  numeric
                  className={
                    line.isFavourable === null
                      ? ''
                      : line.isFavourable
                        ? 'text-mint-700'
                        : 'text-flag-500'
                  }
                >
                  {line.variance.amount}
                </Td>
                <Td numeric mono muted>
                  {line.variancePercent ?? '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
          <TFoot>
            <tr>
              <Td colSpan={2} className="text-end text-[11px] uppercase tracking-wider text-ink-500">
                Totals ({variance.data.currency})
              </Td>
              <Td numeric>
                <Money value={variance.data.totalBudget} bold />
              </Td>
              <Td numeric>
                <Money value={variance.data.totalActual} bold />
              </Td>
              <Td numeric>
                <Money value={variance.data.totalVariance} bold />
              </Td>
              <Td />
            </tr>
          </TFoot>
        </DataTable>
      ) : (
        <EmptyState>Loading…</EmptyState>
      )}

      <p className="text-xs text-ink-400">
        Green is favourable and red is not, decided by the account type rather than the sign: revenue
        short of budget and expense over it are both unfavourable.
      </p>
    </>
  );
}
