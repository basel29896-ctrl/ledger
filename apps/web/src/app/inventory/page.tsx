'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  Card,
  DataTable,
  ErrorBanner,
  Field,
  Input,
  Money,
  PageHeader,
  StatusNote,
  TFoot,
  THead,
  Td,
  Th,
  Toolbar,
  Tr,
} from '../../components/ui';

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
    <>
      <PageHeader
        title="Inventory"
        subtitle="Stock valuation, and whether it agrees with the inventory accounts."
      />

      <Toolbar>
        <Field label="Valuation as at" hint="Leave blank for today">
          <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </Field>
      </Toolbar>

      <ErrorBanner error={valuation.error ?? movements.error} />

      {valuation.data ? (
        <>
          <DataTable scroll>
            <THead>
              <tr>
                <Th className="w-28">SKU</Th>
                <Th>Item</Th>
                <Th className="w-28">Warehouse</Th>
                <Th className="w-36">Method</Th>
                <Th numeric className="w-32">
                  Quantity
                </Th>
                <Th numeric className="w-40">
                  Value
                </Th>
              </tr>
            </THead>
            <tbody>
              {valuation.data.items.map((row) => (
                <Tr
                  key={`${row.itemId}-${row.warehouse}`}
                  interactive
                  onClick={() => setItemId(row.itemId)}
                >
                  <Td mono muted>
                    {row.sku}
                  </Td>
                  <Td className="text-ink-700 underline decoration-ice-300 underline-offset-2">
                    {row.name}
                  </Td>
                  <Td>{row.warehouse}</Td>
                  <Td muted className="text-xs">
                    {row.costingMethod.replace(/_/g, ' ')}
                  </Td>
                  <Td numeric mono>
                    {row.quantity}
                  </Td>
                  <Td numeric>
                    <Money value={row.value} />
                  </Td>
                </Tr>
              ))}
            </tbody>
            <TFoot>
              <tr>
                <Td colSpan={5} className="text-end text-[11px] uppercase tracking-wider text-ink-500">
                  Total ({valuation.data.currency})
                </Td>
                <Td numeric>
                  <Money value={valuation.data.totalValue} bold />
                </Td>
              </tr>
            </TFoot>
          </DataTable>

          <StatusNote tone={valuation.data.agreesWithLedger ? 'good' : 'bad'}>
            {valuation.data.agreesWithLedger
              ? 'Stock valuation agrees with the inventory accounts in the ledger.'
              : `Stock says ${valuation.data.totalValue.amount} but the ledger carries ` +
                `${valuation.data.ledgerInventoryValue.amount}. Stock and ledger have drifted — ` +
                `investigate before relying on either.`}
          </StatusNote>
        </>
      ) : null}

      {movements.data ? (
        <Card title="Movements" padded={false}>
          <DataTable className="rounded-none border-0">
            <THead>
              <tr>
                <Th className="w-28">Date</Th>
                <Th className="w-32">Kind</Th>
                <Th className="w-28">Warehouse</Th>
                <Th numeric className="w-32">
                  Quantity
                </Th>
                <Th numeric className="w-36">
                  Unit cost
                </Th>
                <Th numeric className="w-36">
                  Value
                </Th>
                <Th className="w-20">Entry</Th>
              </tr>
            </THead>
            <tbody>
              {movements.data.map((m) => (
                <Tr key={m.id}>
                  <Td mono muted>
                    {m.movementDate}
                  </Td>
                  <Td className="capitalize">{m.kind.replace(/_/g, ' ')}</Td>
                  <Td>{m.warehouse}</Td>
                  <Td numeric mono>
                    {m.quantity}
                  </Td>
                  <Td numeric>
                    <Money value={m.unitCost} />
                  </Td>
                  <Td numeric>
                    <Money value={m.value} />
                  </Td>
                  <Td>
                    {/* Every movement reaches the entry it posted. */}
                    {m.entryId ? (
                      <a
                        href={`/journal/${m.entryId}`}
                        className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                      >
                        view
                      </a>
                    ) : (
                      <span className="text-ink-300">transfer</span>
                    )}
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
