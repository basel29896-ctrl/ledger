'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDto } from '@acct/shared';
import { api } from '../../lib/api';
import { useSession, can } from '../../lib/session';
import { Button, Card, ErrorBanner, Field, Input, Select } from '../../components/ui';

interface TreeNode extends AccountDto {
  depth: number;
}

/** Flatten the parent/child hierarchy into rows, preserving code order. */
function toTree(accounts: AccountDto[]): TreeNode[] {
  const byParent = new Map<string | null, AccountDto[]>();
  for (const account of accounts) {
    const key = account.parentAccountId;
    byParent.set(key, [...(byParent.get(key) ?? []), account]);
  }
  const out: TreeNode[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const account of (byParent.get(parent) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      out.push({ ...account, depth });
      walk(account.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState('');

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<AccountDto[]>('/accounts'),
  });

  const rows = useMemo(() => {
    const tree = toTree(accounts);
    if (!filter.trim()) return tree;
    const needle = filter.toLowerCase();
    return tree.filter(
      (a) => a.code.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle),
    );
  }, [accounts, filter]);

  const create = useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<AccountDto>('/accounts', input),
    onSuccess: async () => {
      setShowNew(false);
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Chart of Accounts</h1>
        <div className="ml-auto w-64">
          <Input
            placeholder="Filter by code or name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {can(session, 'ledger.account.write') ? (
          <Button onClick={() => setShowNew((v) => !v)}>{showNew ? 'Cancel' : 'New account'}</Button>
        ) : null}
      </div>

      {showNew ? (
        <Card title="New account">
          <NewAccountForm
            accounts={accounts}
            error={create.error}
            busy={create.isPending}
            onSubmit={(input) => create.mutate(input)}
          />
        </Card>
      ) : null}

      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Code</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Normal</th>
              <th className="px-3 py-2 font-medium">Currency</th>
              <th className="px-3 py-2 font-medium">Postable</th>
              <th className="px-3 py-2 font-medium">Ledger</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : (
              rows.map((account) => (
                <tr key={account.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono text-xs">{account.code}</td>
                  <td className="px-3 py-1.5" style={{ paddingLeft: `${12 + account.depth * 16}px` }}>
                    <span className={account.isPostable ? '' : 'font-semibold text-slate-700'}>
                      {account.name}
                    </span>
                    {account.nameAr ? (
                      <span className="ml-2 text-xs text-slate-400" dir="rtl">
                        {account.nameAr}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">{account.type}</td>
                  <td className="px-3 py-1.5 text-slate-600">{account.normalBalance}</td>
                  <td className="px-3 py-1.5 text-slate-600">{account.currencyCode ?? 'any'}</td>
                  <td className="px-3 py-1.5">
                    {account.isPostable ? (
                      <span className="text-green-700">yes</span>
                    ) : (
                      <span className="text-slate-400">summary</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {account.isPostable ? (
                      <Link
                        href={`/reports/general-ledger?accountId=${account.id}`}
                        className="text-slate-900 underline"
                      >
                        view
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {rows.length} of {accounts.length} accounts. Summary accounts cannot be posted to — the
        database refuses it.
      </p>
    </div>
  );
}

function NewAccountForm({
  accounts,
  onSubmit,
  busy,
  error,
}: {
  accounts: AccountDto[];
  onSubmit: (input: Record<string, unknown>) => void;
  busy: boolean;
  error: unknown;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [type, setType] = useState('expense');
  const [parentAccountId, setParentAccountId] = useState('');

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          code,
          name,
          type,
          ...(nameAr ? { nameAr } : {}),
          ...(parentAccountId ? { parentAccountId } : {}),
        });
      }}
    >
      <ErrorBanner error={error} />
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Code">
          <Input value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Name (Arabic)">
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
        </Field>
        <Field label="Type" hint="The normal balance follows from the type.">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="asset">asset</option>
            <option value="liability">liability</option>
            <option value="equity">equity</option>
            <option value="revenue">revenue</option>
            <option value="expense">expense</option>
          </Select>
        </Field>
        <Field label="Parent">
          <Select value={parentAccountId} onChange={(e) => setParentAccountId(e.target.value)}>
            <option value="">(top level)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Create account'}
      </Button>
    </form>
  );
}
