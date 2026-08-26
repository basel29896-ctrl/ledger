'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Card, ErrorBanner, Field, Input, Money } from '../../components/ui';

interface Asset {
  id: string;
  assetNo: string;
  name: string;
  category: string | null;
  status: string;
  method: string;
  cost: { amount: string };
  accumulated: { amount: string };
  netBookValue: { amount: string };
  inServiceOn: string;
  disposedOn: string | null;
}

interface Register {
  currency: string;
  assets: Asset[];
  totalCost: { amount: string };
  totalAccumulated: { amount: string };
  totalNetBookValue: { amount: string };
}

interface ScheduleRow {
  periodNo: number;
  periodEnd: string;
  chargeMinor: string;
  closingNetBookValueMinor: string;
}

export default function AssetsPage() {
  const queryClient = useQueryClient();
  const [periodEnd, setPeriodEnd] = useState('');
  const [assetId, setAssetId] = useState('');

  const register = useQuery({
    queryKey: ['asset-register'],
    queryFn: () => api.get<Register>('/assets/register'),
  });

  const schedule = useQuery({
    queryKey: ['asset-schedule', assetId],
    queryFn: () => api.get<{ rows: ScheduleRow[] }>(`/assets/${assetId}/schedule`),
    enabled: assetId !== '',
  });

  const run = useMutation({
    mutationFn: () =>
      api.post<{ totalCharge: { amount: string }; charges: unknown[] }>('/assets/depreciation-runs', {
        periodEnd,
      }),
    // No optimistic write: read the register back from the server.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['asset-register'] }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Fixed Assets</h1>

      <Card title="Depreciation run">
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <Field label="Period end" hint="The last day of the month being charged">
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
          <Button disabled={!periodEnd || run.isPending} onClick={() => run.mutate()}>
            Run depreciation
          </Button>
          {run.data ? (
            <p className="text-sm text-slate-700">
              Charged {run.data.totalCharge.amount} across {run.data.charges.length} asset(s).
            </p>
          ) : null}
        </div>
      </Card>

      <ErrorBanner error={register.error ?? run.error ?? schedule.error} />

      {register.data ? (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">No.</th>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">In service</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Accumulated</th>
                <th className="px-3 py-2 text-right font-medium">Net book value</th>
              </tr>
            </thead>
            <tbody>
              {register.data.assets.map((asset) => (
                <tr
                  key={asset.id}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  onClick={() => setAssetId(asset.id)}
                >
                  <td className="px-3 py-1.5 font-mono text-xs">{asset.assetNo}</td>
                  <td className="px-3 py-1.5 underline">{asset.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{asset.method}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{asset.inServiceOn}</td>
                  <td className="px-3 py-1.5">{asset.status}</td>
                  <td className="px-3 py-1.5 text-right"><Money value={asset.cost} /></td>
                  <td className="px-3 py-1.5 text-right"><Money value={asset.accumulated} /></td>
                  <td className="px-3 py-1.5 text-right"><Money value={asset.netBookValue} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-300 bg-slate-50">
              <tr>
                <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase text-slate-600">
                  Totals ({register.data.currency})
                </td>
                <td className="px-3 py-2 text-right"><Money value={register.data.totalCost} bold /></td>
                <td className="px-3 py-2 text-right"><Money value={register.data.totalAccumulated} bold /></td>
                <td className="px-3 py-2 text-right"><Money value={register.data.totalNetBookValue} bold /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {schedule.data ? (
        <Card title="Depreciation schedule">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-600">
              <tr>
                <th className="px-2 py-1.5 font-medium">Period</th>
                <th className="px-2 py-1.5 font-medium">Ends</th>
                <th className="px-2 py-1.5 text-right font-medium">Charge</th>
                <th className="px-2 py-1.5 text-right font-medium">Net book value</th>
              </tr>
            </thead>
            <tbody>
              {schedule.data.rows.map((row) => (
                <tr key={row.periodNo} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono text-xs">{row.periodNo}</td>
                  <td className="px-2 py-1 font-mono text-xs">{row.periodEnd}</td>
                  <td className="px-2 py-1 text-right font-mono text-xs">{row.chargeMinor}</td>
                  <td className="px-2 py-1 text-right font-mono text-xs">{row.closingNetBookValueMinor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
