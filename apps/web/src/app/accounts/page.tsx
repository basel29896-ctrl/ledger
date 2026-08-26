'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDto } from '@acct/shared';
import { api } from '../../lib/api';
import { useSession, can } from '../../lib/session';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBanner,
  Field,
  Input,
  LoadingRow,
  PageHeader,
  Select,
  THead,
  Td,
  Th,
  Tr,
} from '../../components/ui';

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
    <>
      <PageHeader
        title="Chart of Accounts"
        subtitle={`${rows.length} of ${accounts.length} accounts · summary accounts cannot be posted to`}
        actions={
          <>
            <div className="w-64">
              <Input
                placeholder="Filter by code or name"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {can(session, 'ledger.account.write') ? (
              <Button onClick={() => setShowNew((v) => !v)}>
                {showNew ? 'Cancel' : 'New account'}
              </Button>
            ) : null}
          </>
        }
      />

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

      <DataTable scroll>
        <THead>
          <tr>
            <Th className="w-24">Code</Th>
            <Th>Name</Th>
            <Th className="w-28">Type</Th>
            <Th className="w-24">Normal</Th>
            <Th className="w-24">Currency</Th>
            <Th className="w-28">Postable</Th>
            <Th className="w-20">Ledger</Th>
          </tr>
        </THead>
        <tbody>
          {isLoading ? (
            <LoadingRow colSpan={7} />
          ) : (
            rows.map((account) => (
              <Tr key={account.id}>
                <Td mono muted>
                  {account.code}
                </Td>
                {/* Indentation carries the hierarchy: one step per level, nothing else. */}
                <Td style={{ paddingInlineStart: `${12 + account.depth * 18}px` }}>
                  <span className={account.isPostable ? 'text-ink-800' : 'font-semibold text-ink-600'}>
                    {account.name}
                  </span>
                  {account.nameAr ? (
                    <span className="ms-2 text-xs text-ink-300" dir="rtl">
                      {account.nameAr}
                    </span>
                  ) : null}
                </Td>
                <Td muted className="text-xs capitalize">
                  {account.type}
                </Td>
                <Td muted className="text-xs capitalize">
                  {account.normalBalance}
                </Td>
                <Td muted className="text-xs">
                  {account.currencyCode ?? 'any'}
                </Td>
                <Td>
                  {account.isPostable ? (
                    <Badge tone="good">postable</Badge>
                  ) : (
                    <Badge>summary</Badge>
                  )}
                </Td>
                <Td>
                  {account.isPostable ? (
                    <Link
                      href={`/reports/general-ledger?accountId=${account.id}`}
                      className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
                    >
                      view
                    </Link>
                  ) : null}
                </Td>
              </Tr>
            ))
          )}
        </tbody>
      </DataTable>
      <p className="text-xs text-ink-400">
        Summary accounts cannot be posted to — the database refuses it, not just this screen.
      </p>
    </>
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
