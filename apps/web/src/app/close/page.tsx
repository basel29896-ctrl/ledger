'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Card, ErrorBanner, Field, Input, Select } from '../../components/ui';

interface ChecklistItem {
  id: string;
  itemCode: string;
  label: string;
  isBlocking: boolean;
  status: 'pending' | 'done' | 'skipped';
  notes: string | null;
}

interface PeriodStatus {
  id: string;
  periodNo: number;
  startDate: string;
  endDate: string;
  status: 'open' | 'soft_closed' | 'closed';
  fiscalYearId: string;
  fiscalYearName: string;
  draftEntries: number;
  checklist: ChecklistItem[];
}

interface PeriodRow {
  id: string;
  periodNo: number;
  startDate: string;
  endDate: string;
  status: string;
}

export default function ClosePage() {
  const queryClient = useQueryClient();
  const [periodId, setPeriodId] = useState('');
  const [asOfDate, setAsOfDate] = useState('');

  const periods = useQuery({
    queryKey: ['fiscal-periods'],
    queryFn: () => api.get<PeriodRow[]>('/fiscal-periods'),
  });

  const selected = periodId || periods.data?.[0]?.id || '';

  const status = useQuery({
    queryKey: ['close-status', selected],
    queryFn: () => api.get<PeriodStatus>(`/fiscal-periods/${selected}/close-status`),
    enabled: selected !== '',
  });

  const invalidate = async (): Promise<void> => {
    // No optimistic writes on a financial mutation: refetch and show the truth.
    await queryClient.invalidateQueries({ queryKey: ['close-status', selected] });
    await queryClient.invalidateQueries({ queryKey: ['fiscal-periods'] });
  };

  const setItem = useMutation({
    mutationFn: (vars: { itemCode: string; status: ChecklistItem['status']; notes?: string }) =>
      api.put<PeriodStatus>(`/fiscal-periods/${selected}/checklist/${vars.itemCode}`, {
        status: vars.status,
        ...(vars.notes ? { notes: vars.notes } : {}),
      }),
    onSuccess: invalidate,
  });

  const setStatus = useMutation({
    mutationFn: (next: PeriodStatus['status']) =>
      api.post<PeriodStatus>(`/fiscal-periods/${selected}/status`, { status: next }),
    onSuccess: invalidate,
  });

  const revalue = useMutation({
    mutationFn: () => api.post<{ netGain: { amount: string } }>('/close/fx-revaluation', { asOfDate }),
    onSuccess: invalidate,
  });

  const closeYear = useMutation({
    mutationFn: () =>
      api.post<{ entryId: string; profit: { amount: string } }>(
        `/close/fiscal-years/${status.data?.fiscalYearId}/closing-entry`,
        {},
      ),
    onSuccess: invalidate,
  });

  const data = status.data;
  const blocking = data?.checklist.filter((i) => i.isBlocking && i.status === 'pending') ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Period Close</h1>

      <Card>
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <Field label="Period">
            <Select value={selected} onChange={(e) => setPeriodId(e.target.value)}>
              {periods.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.periodNo.toString().padStart(2, '0')} · {p.startDate} → {p.endDate} ({p.status})
                </option>
              ))}
            </Select>
          </Field>
          <div className="text-sm text-slate-600">
            {data ? (
              <>
                Status: <span className="font-medium">{data.status}</span>
                {data.draftEntries > 0 ? (
                  <span className="ml-2 text-amber-700">{data.draftEntries} draft entries</span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </Card>

      <ErrorBanner error={status.error ?? setItem.error ?? setStatus.error ?? revalue.error ?? closeYear.error} />

      <Card title="Checklist">
        <table className="w-full text-sm">
          <tbody>
            {data?.checklist.map((item) => (
              <tr key={item.id} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1.5">
                  {item.label}
                  {item.isBlocking ? <span className="ml-2 text-xs text-slate-500">blocking</span> : null}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <span
                    className={
                      item.status === 'done'
                        ? 'text-green-700'
                        : item.status === 'skipped'
                          ? 'text-amber-700'
                          : 'text-slate-500'
                    }
                  >
                    {item.status}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Button
                    variant="secondary"
                    disabled={data.status === 'closed' || setItem.isPending}
                    onClick={() => setItem.mutate({ itemCode: item.itemCode, status: 'done' })}
                  >
                    Mark done
                  </Button>
                  <Button
                    variant="secondary"
                    className="ml-2"
                    disabled={data.status === 'closed' || setItem.isPending}
                    onClick={() => {
                      const notes = window.prompt('Reason for skipping this item?')?.trim();
                      if (notes) setItem.mutate({ itemCode: item.itemCode, status: 'skipped', notes });
                    }}
                  >
                    Skip…
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Close">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            disabled={!data || data.status !== 'open' || setStatus.isPending}
            onClick={() => setStatus.mutate('soft_closed')}
          >
            Soft close
          </Button>
          <Button
            disabled={!data || data.status === 'closed' || blocking.length > 0 || setStatus.isPending}
            onClick={() => setStatus.mutate('closed')}
          >
            Hard close
          </Button>
          <Button
            variant="secondary"
            disabled={!data || data.status === 'open' || setStatus.isPending}
            onClick={() => setStatus.mutate('open')}
          >
            Reopen
          </Button>
          {blocking.length > 0 ? (
            <span className="text-sm text-amber-700">
              {blocking.length} blocking item(s) outstanding: {blocking.map((i) => i.label).join(', ')}
            </span>
          ) : null}
        </div>
      </Card>

      <Card title="Close routines">
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <Field label="Revalue foreign currency as at">
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
          <Button disabled={!asOfDate || revalue.isPending} onClick={() => revalue.mutate()}>
            Run FX revaluation
          </Button>
          <Button
            variant="secondary"
            disabled={!data || closeYear.isPending}
            onClick={() => closeYear.mutate()}
          >
            Post year-end closing entry ({data?.fiscalYearName})
          </Button>
        </div>
        {revalue.data ? (
          <p className="mt-3 text-sm text-slate-700">
            Revaluation posted. Net gain: {revalue.data.netGain.amount}
          </p>
        ) : null}
        {closeYear.data ? (
          <p className="mt-3 text-sm text-slate-700">
            Closing entry posted. Profit moved to retained earnings: {closeYear.data.profit.amount}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
