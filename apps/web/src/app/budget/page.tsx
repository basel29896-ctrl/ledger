'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card, ErrorBanner, Field, Input, Money, Select } from '../../components/ui';

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
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Budget vs Actual</h1>

      <Card>
        <div className="grid items-end gap-3 sm:grid-cols-4">
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
        </div>
      </Card>

      <ErrorBanner error={budgets.error ?? variance.error} />

      {!ready ? (
        <p className="text-sm text-slate-500">Choose a budget and a date range.</p>
      ) : variance.data ? (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 text-right font-medium">Budget</th>
                <th className="px-3 py-2 text-right font-medium">Actual</th>
                <th className="px-3 py-2 text-right font-medium">Variance</th>
                <th className="px-3 py-2 text-right font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {variance.data.lines.map((line) => (
                <tr key={line.accountId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono text-xs">{line.code}</td>
                  <td className="px-3 py-1.5">
                    <a href={`/reports/general-ledger?accountId=${line.accountId}`} className="underline">
                      {line.name}
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-right"><Money value={line.budget} /></td>
                  <td className="px-3 py-1.5 text-right"><Money value={line.actual} /></td>
                  <td
                    className={`px-3 py-1.5 text-right ${
                      line.isFavourable === null
                        ? ''
                        : line.isFavourable
                          ? 'text-green-700'
                          : 'text-red-700'
                    }`}
                  >
                    <Money value={line.variance} />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {line.variancePercent ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-300 bg-slate-50">
              <tr>
                <td colSpan={2} className="px-3 py-2 text-right text-xs uppercase text-slate-600">
                  Totals ({variance.data.currency})
                </td>
                <td className="px-3 py-2 text-right"><Money value={variance.data.totalBudget} bold /></td>
                <td className="px-3 py-2 text-right"><Money value={variance.data.totalActual} bold /></td>
                <td className="px-3 py-2 text-right"><Money value={variance.data.totalVariance} bold /></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      <p className="text-xs text-slate-500">
        Green is favourable and red is not, decided by the account type rather than the sign: revenue
        short of budget and expense over it are both unfavourable.
      </p>
    </div>
  );
}
