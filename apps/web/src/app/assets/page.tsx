'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBanner,
  Field,
  Input,
  Money,
  PageHeader,
  TFoot,
  THead,
  Td,
  Th,
  Toolbar,
  Tr,
} from '../../components/ui';

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
    <>
      <PageHeader
        title="Fixed Assets"
        subtitle="Charged once per asset per period — the database refuses a second run."
      />

      <Toolbar
        actions={
          <Button disabled={!periodEnd || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running…' : 'Run depreciation'}
          </Button>
        }
      >
        <Field label="Period end" hint="The last day of the month being charged">
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
        {run.data ? (
          <p className="self-end pb-1.5 text-sm text-ink-500">
            Charged {run.data.totalCharge.amount} across {run.data.charges.length} asset(s).
          </p>
        ) : null}
      </Toolbar>

      <ErrorBanner error={register.error ?? run.error ?? schedule.error} />

      {register.data ? (
        <DataTable scroll>
          <THead>
            <tr>
              <Th className="w-24">No.</Th>
              <Th>Asset</Th>
              <Th className="w-36">Method</Th>
              <Th className="w-28">In service</Th>
              <Th className="w-28">Status</Th>
              <Th numeric className="w-36">
                Cost
              </Th>
              <Th numeric className="w-36">
                Accumulated
              </Th>
              <Th numeric className="w-40">
                Net book value
              </Th>
            </tr>
          </THead>
          <tbody>
            {register.data.assets.map((asset) => (
              <Tr key={asset.id} interactive onClick={() => setAssetId(asset.id)}>
                <Td mono muted>
                  {asset.assetNo}
                </Td>
                <Td className="text-ink-700 underline decoration-ice-300 underline-offset-2">
                  {asset.name}
                </Td>
                <Td muted className="text-xs">
                  {asset.method.replace(/_/g, ' ')}
                </Td>
                <Td mono muted>
                  {asset.inServiceOn}
                </Td>
                <Td>
                  <Badge tone={asset.status === 'in_service' ? 'good' : 'neutral'}>
                    {asset.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money value={asset.cost} />
                </Td>
                <Td numeric>
                  <Money value={asset.accumulated} />
                </Td>
                <Td numeric>
                  <Money value={asset.netBookValue} />
                </Td>
              </Tr>
            ))}
          </tbody>
          <TFoot>
            <tr>
              <Td colSpan={5} className="text-end text-[11px] uppercase tracking-wider text-ink-500">
                Totals ({register.data.currency})
              </Td>
              <Td numeric>
                <Money value={register.data.totalCost} bold />
              </Td>
              <Td numeric>
                <Money value={register.data.totalAccumulated} bold />
              </Td>
              <Td numeric>
                <Money value={register.data.totalNetBookValue} bold />
              </Td>
            </tr>
          </TFoot>
        </DataTable>
      ) : null}

      {schedule.data ? (
        <Card title="Depreciation schedule" padded={false}>
          <DataTable className="rounded-none border-0" scroll>
            <THead>
              <tr>
                <Th className="w-20">Period</Th>
                <Th className="w-32">Ends</Th>
                <Th numeric className="w-40">
                  Charge
                </Th>
                <Th numeric className="w-44">
                  Net book value
                </Th>
              </tr>
            </THead>
            <tbody>
              {schedule.data.rows.map((row) => (
                <Tr key={row.periodNo}>
                  <Td mono muted>
                    {row.periodNo}
                  </Td>
                  <Td mono muted>
                    {row.periodEnd}
                  </Td>
                  <Td numeric mono>
                    {row.chargeMinor}
                  </Td>
                  <Td numeric mono>
                    {row.closingNetBookValueMinor}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      ) : null}
    </>
  );
}
