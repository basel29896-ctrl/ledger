'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { TrialBalanceDto } from '@acct/shared';
import { api } from '../lib/api';
import { Card, Money } from '../components/ui';

interface IncomeStatement {
  revenue: { total: { amount: string } };
  grossProfit: { amount: string };
  netProfit: { amount: string };
  currency: string;
}

interface CashFlow {
  closingCash: { amount: string };
  netMovement: { amount: string };
  reconciles: boolean;
}

interface Valuation {
  totalValue: { amount: string };
  agreesWithLedger: boolean;
}

interface AssetRegister {
  totalNetBookValue: { amount: string };
}

/** The first and last day of the month a date falls in. */
function monthRange(date = new Date()): { from: string; to: string } {
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default function Home() {
  const { from, to } = monthRange();

  const tb = useQuery({
    queryKey: ['trial-balance', 'summary'],
    queryFn: () => api.get<TrialBalanceDto>('/reports/trial-balance'),
  });
  const pl = useQuery({
    queryKey: ['dashboard-pl', from, to],
    queryFn: () => api.get<IncomeStatement>(`/reports/income-statement?fromDate=${from}&toDate=${to}`),
  });
  const cash = useQuery({
    queryKey: ['dashboard-cash', from, to],
    queryFn: () => api.get<CashFlow>(`/reports/cash-flow?fromDate=${from}&toDate=${to}`),
  });
  const stock = useQuery({
    queryKey: ['dashboard-stock'],
    queryFn: () => api.get<Valuation>('/inventory/valuation'),
    retry: false,
  });
  const assets = useQuery({
    queryKey: ['dashboard-assets'],
    queryFn: () => api.get<AssetRegister>('/assets/register'),
    retry: false,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Overview</h1>

      {/* The health line first: if the books do not balance, nothing else matters. */}
      {tb.data ? (
        <div
          className={`rounded border px-3 py-2 text-sm ${
            tb.data.balanced
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-300 bg-red-50 text-red-800'
          }`}
        >
          {tb.data.balanced
            ? 'The books balance: debits equal credits across every account.'
            : `OUT OF BALANCE by ${tb.data.difference.amount} — investigate before relying on any report below.`}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title={`This month (${from} → ${to})`}>
          {pl.data ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Revenue</dt>
                <dd><Money value={pl.data.revenue.total} /></dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Gross profit</dt>
                <dd><Money value={pl.data.grossProfit} /></dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1">
                <dt className="text-slate-600">Net profit</dt>
                <dd><Money value={pl.data.netProfit} bold /></dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
          <Link href="/reports/income-statement" className="mt-2 inline-block text-xs underline">
            Open the income statement
          </Link>
        </Card>

        <Card title="Cash">
          {cash.data ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Closing cash</dt>
                <dd><Money value={cash.data.closingCash} bold /></dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Movement</dt>
                <dd><Money value={cash.data.netMovement} /></dd>
              </div>
              <p className={`pt-1 text-xs ${cash.data.reconciles ? 'text-green-700' : 'text-red-700'}`}>
                {cash.data.reconciles
                  ? 'Reconciles to the bank accounts.'
                  : 'Does not tie to the bank — investigate.'}
              </p>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
          <Link href="/reports/cash-flow" className="mt-2 inline-block text-xs underline">
            Open the cash flow statement
          </Link>
        </Card>

        <Card title="Inventory">
          {stock.data ? (
            <>
              <p className="text-sm"><Money value={stock.data.totalValue} bold /></p>
              <p className={`text-xs ${stock.data.agreesWithLedger ? 'text-green-700' : 'text-red-700'}`}>
                {stock.data.agreesWithLedger
                  ? 'Agrees with the inventory accounts.'
                  : 'Stock and ledger disagree — investigate.'}
              </p>
              <Link href="/inventory" className="mt-2 inline-block text-xs underline">
                Open inventory
              </Link>
            </>
          ) : (
            <p className="text-sm text-slate-500">—</p>
          )}
        </Card>

        <Card title="Fixed assets">
          {assets.data ? (
            <>
              <p className="text-sm">
                <Money value={assets.data.totalNetBookValue} bold />
              </p>
              <p className="text-xs text-slate-600">Net book value</p>
              <Link href="/assets" className="mt-2 inline-block text-xs underline">
                Open the register
              </Link>
            </>
          ) : (
            <p className="text-sm text-slate-500">—</p>
          )}
        </Card>
      </div>

      <Card title="Trial balance">
        {tb.data ? (
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-600">Debits</span>
              <Money value={tb.data.totalDebit} />
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Credits</span>
              <Money value={tb.data.totalCredit} />
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-1">
              <span className="text-slate-600">Difference</span>
              <Money value={tb.data.difference} bold />
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
        <Link href="/reports/trial-balance" className="mt-2 inline-block text-xs underline">
          Open the trial balance
        </Link>
      </Card>
    </div>
  );
}
