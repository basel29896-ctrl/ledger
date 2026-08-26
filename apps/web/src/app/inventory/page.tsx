'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card, ErrorBanner, Field, Input, Money } from '../../components/ui';

interface ValuationRow {
  itemId: string;
  sku: string;
  name: string;
  warehouse: string;
  costingMethod: string;
  quantity: string;
  value: { amount: string };
}

interface Valuation {
  currency: string;
  items: ValuationRow[];
  totalValue: { amount: string };
  ledgerInventoryValue: { amount: string };
  agreesWithLedger: boolean;
}

interface Movement {
  id: string;
  kind: string;
  movementDate: string;
  quantity: string;
  unitCost: { amount: string };
  value: { amount: string };
  warehouse: string;
  entryId: string | null;
}

export default function InventoryPage() {
  const [asOfDate, setAsOfDate] = useState('');
  const [itemId, setItemId] = useState('');

  const valuation = useQuery({
    queryKey: ['inventory-valuation', asOfDate],
    queryFn: () =>
      api.get<Valuation>(`/inventory/valuation${asOfDate ? `?asOfDate=${asOfDate}` : ''}`),
  });

  const movements = useQuery({
    queryKey: ['inventory-movements', itemId],
    queryFn: () => api.get<Movement[]>(`/inventory/items/${itemId}/movements`),
    enabled: itemId !== '',
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Inventory</h1>

      <Card>
        <div className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="Valuation as at" hint="Leave blank for today">
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      <ErrorBanner error={valuation.error ?? movements.error} />

      {valuation.data ? (
        <>
          <div className="overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Warehouse</th>
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {valuation.data.items.map((row) => (
                  <tr
                    key={`${row.itemId}-${row.warehouse}`}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    onClick={() => setItemId(row.itemId)}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs">{row.sku}</td>
                    <td className="px-3 py-1.5 underline">{row.name}</td>
                    <td className="px-3 py-1.5">{row.warehouse}</td>
                    <td className="px-3 py-1.5 text-slate-500">{row.costingMethod}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{row.quantity}</td>
                    <td className="px-3 py-1.5 text-right"><Money value={row.value} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-300 bg-slate-50">
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase text-slate-600">
                    Total ({valuation.data.currency})
                  </td>
                  <td className="px-3 py-2 text-right"><Money value={valuation.data.totalValue} bold /></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className={`text-sm ${valuation.data.agreesWithLedger ? 'text-green-700' : 'text-red-700'}`}>
            {valuation.data.agreesWithLedger
              ? 'Stock valuation agrees with the inventory accounts in the ledger.'
              : `Stock says ${valuation.data.totalValue.amount} but the ledger carries ` +
                `${valuation.data.ledgerInventoryValue.amount}. Stock and ledger have drifted — investigate ` +
                `before relying on either.`}
          </p>
        </>
      ) : null}

      {movements.data ? (
        <Card title="Movements">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-600">
              <tr>
                <th className="px-2 py-1.5 font-medium">Date</th>
                <th className="px-2 py-1.5 font-medium">Kind</th>
                <th className="px-2 py-1.5 font-medium">Warehouse</th>
                <th className="px-2 py-1.5 text-right font-medium">Quantity</th>
                <th className="px-2 py-1.5 text-right font-medium">Unit cost</th>
                <th className="px-2 py-1.5 text-right font-medium">Value</th>
                <th className="px-2 py-1.5 font-medium">Entry</th>
              </tr>
            </thead>
            <tbody>
              {movements.data.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-mono text-xs">{m.movementDate}</td>
                  <td className="px-2 py-1.5">{m.kind}</td>
                  <td className="px-2 py-1.5">{m.warehouse}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{m.quantity}</td>
                  <td className="px-2 py-1.5 text-right"><Money value={m.unitCost} /></td>
                  <td className="px-2 py-1.5 text-right"><Money value={m.value} /></td>
                  <td className="px-2 py-1.5">
                    {/* Every movement reaches the entry it posted. */}
                    {m.entryId ? (
                      <a href={`/journal/${m.entryId}`} className="underline">
                        view
                      </a>
                    ) : (
                      <span className="text-slate-400">transfer</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
