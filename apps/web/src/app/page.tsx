'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { TrialBalanceDto } from '@acct/shared';
import { api } from '../lib/api';
import { Card, Money, PageHeader, Stat, StatusNote } from '../components/ui';

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

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mt-3 inline-block text-xs font-medium text-ink-600 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
    >
      {children}
    </Link>
  );
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
    <>
      <PageHeader title="Overview" subtitle={`Month to date · ${from} → ${to}`} />

      {/* The health line first: if the books do not balance, nothing else matters. */}
      {tb.data ? (
        <StatusNote tone={tb.data.balanced ? 'good' : 'bad'}>
          {tb.data.balanced
            ? 'The books balance: debits equal credits across every account.'
            : `OUT OF BALANCE by ${tb.data.difference.amount} — investigate before relying on any report below.`}
        </StatusNote>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card title="This month">
          {pl.data ? (
            <div className="space-y-3">
              <Stat label="Net profit" value={<Money value={pl.data.netProfit} bold />} />
              <dl className="space-y-1 border-t border-ice-100 pt-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-400">Revenue</dt>
                  <dd>
                    <Money value={pl.data.revenue.total} />
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-400">Gross profit</dt>
                  <dd>
                    <Money value={pl.data.grossProfit} />
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="text-sm text-ink-400">Loading…</p>
          )}
          <CardLink href="/reports/income-statement">Open the income statement</CardLink>
        </Card>

        <Card title="Cash">
          {cash.data ? (
            <Stat
              label="Closing cash"
              value={<Money value={cash.data.closingCash} bold />}
              tone={cash.data.reconciles ? 'good' : 'bad'}
              note={
                cash.data.reconciles
                  ? `Movement ${cash.data.netMovement.amount} · reconciles to the bank`
                  : 'Does not tie to the bank — investigate'
              }
            />
          ) : (
            <p className="text-sm text-ink-400">Loading…</p>
          )}
          <CardLink href="/reports/cash-flow">Open the cash flow statement</CardLink>
        </Card>

        <Card title="Inventory">
          {stock.data ? (
            <Stat
              label="Stock on hand"
              value={<Money value={stock.data.totalValue} bold />}
              tone={stock.data.agreesWithLedger ? 'good' : 'bad'}
              note={
                stock.data.agreesWithLedger
                  ? 'Agrees with the inventory accounts'
                  : 'Stock and ledger disagree — investigate'
              }
            />
          ) : (
            <p className="text-sm text-ink-300">—</p>
          )}
          <CardLink href="/inventory">Open inventory</CardLink>
        </Card>

        <Card title="Fixed assets">
          {assets.data ? (
            <Stat
              label="Net book value"
              value={<Money value={assets.data.totalNetBookValue} bold />}
            />
          ) : (
            <p className="text-sm text-ink-300">—</p>
          )}
          <CardLink href="/assets">Open the register</CardLink>
        </Card>
      </div>

      <Card title="Trial balance">
        {tb.data ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Debits" value={<Money value={tb.data.totalDebit} />} />
            <Stat label="Credits" value={<Money value={tb.data.totalCredit} />} />
            <Stat
              label="Difference"
              value={<Money value={tb.data.difference} bold />}
              tone={tb.data.balanced ? 'good' : 'bad'}
              note={tb.data.balanced ? 'Balanced' : 'Out of balance'}
            />
          </div>
        ) : (
          <p className="text-sm text-ink-400">Loading…</p>
        )}
        <CardLink href="/reports/trial-balance">Open the trial balance</CardLink>
      </Card>
    </>
  );
}
