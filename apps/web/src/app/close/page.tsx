'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  StatusNote,
  Toolbar,
} from '../../components/ui';

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

  const statusTone = { open: 'good', soft_closed: 'warn', closed: 'neutral' } as const;

  return (
    <>
      <PageHeader
        title="Period Close"
        subtitle="A soft close admits adjustments only; a hard close admits nothing."
        actions={
          data ? (
            <>
              <Badge tone={statusTone[data.status]}>{data.status.replace(/_/g, ' ')}</Badge>
              {data.draftEntries > 0 ? (
                <Badge tone="warn">{data.draftEntries} draft entries</Badge>
              ) : null}
            </>
          ) : null
        }
      />

      <Toolbar>
        <Field label="Period">
          <Select value={selected} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.periodNo.toString().padStart(2, '0')} · {p.startDate} → {p.endDate} ({p.status})
              </option>
            ))}
          </Select>
        </Field>
      </Toolbar>

      <ErrorBanner
        error={status.error ?? setItem.error ?? setStatus.error ?? revalue.error ?? closeYear.error}
      />

      <Card title="Checklist" padded={false}>
        <table className="w-full text-sm">
          <tbody>
            {data?.checklist.map((item) => (
              <tr key={item.id} className="border-b border-ice-100 last:border-0 hover:bg-ice-50">
                <td className="px-4 py-2">
                  {item.label}
                  {item.isBlocking ? (
                    <span className="ms-2 text-[11px] uppercase tracking-wide text-ink-300">
                      blocking
                    </span>
                  ) : null}
                  {item.notes ? (
                    <span className="ms-2 text-xs text-ink-400">— {item.notes}</span>
                  ) : null}
                </td>
                <td className="w-24 px-3 py-2 text-end">
                  <Badge
                    tone={
                      item.status === 'done' ? 'good' : item.status === 'skipped' ? 'warn' : 'neutral'
                    }
                  >
                    {item.status}
                  </Badge>
                </td>
                <td className="w-56 px-4 py-2 text-end">
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={data.status === 'closed' || setItem.isPending}
                      onClick={() => setItem.mutate({ itemCode: item.itemCode, status: 'done' })}
                    >
                      Mark done
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={data.status === 'closed' || setItem.isPending}
                      onClick={() => {
                        const notes = window.prompt('Reason for skipping this item?')?.trim();
                        if (notes) setItem.mutate({ itemCode: item.itemCode, status: 'skipped', notes });
                      }}
                    >
                      Skip…
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {blocking.length > 0 ? (
        <StatusNote tone="warn">
          {blocking.length} blocking item(s) outstanding: {blocking.map((i) => i.label).join(', ')}
        </StatusNote>
      ) : null}

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
            variant="ghost"
            disabled={!data || data.status === 'open' || setStatus.isPending}
            onClick={() => setStatus.mutate('open')}
          >
            Reopen
          </Button>
        </div>
      </Card>

      <Card title="Close routines">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Revalue foreign currency as at">
              <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
            </Field>
          </div>
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
          <p className="mt-3 text-sm text-ink-500">
            Revaluation posted. Net gain: {revalue.data.netGain.amount}
          </p>
        ) : null}
        {closeYear.data ? (
          <p className="mt-3 text-sm text-ink-500">
            Closing entry posted. Profit moved to retained earnings: {closeYear.data.profit.amount}
          </p>
        ) : null}
      </Card>
    </>
  );
}
