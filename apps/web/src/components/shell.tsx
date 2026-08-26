'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

const NAV = [
  { href: '/accounts', label: 'Chart of Accounts', permission: 'ledger.account.read' },
  { href: '/journal', label: 'Journal', permission: 'ledger.entry.read' },
  { href: '/close', label: 'Period Close', permission: 'ledger.period.close' },
  { href: '/reports/trial-balance', label: 'Trial Balance', permission: 'report.read' },
  { href: '/reports/income-statement', label: 'P&L', permission: 'report.read' },
  { href: '/reports/balance-sheet', label: 'Balance Sheet', permission: 'report.read' },
  { href: '/reports/cash-flow', label: 'Cash Flow', permission: 'report.read' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session, isLoading } = useSession();

  if (pathname === '/login') return <>{children}</>;

  if (isLoading) {
    return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  }

  if (!session) {
    return (
      <div className="p-8 text-sm">
        <p className="text-slate-700">You are not signed in.</p>
        <Link href="/login" className="mt-2 inline-block text-slate-900 underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  const signOut = async (): Promise<void> => {
    await api.post('/auth/logout');
    queryClient.clear();
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-6 px-4">
          <Link href="/" className="text-sm font-semibold text-slate-900">
            Accounting
          </Link>
          <nav className="flex gap-1">
            {NAV.filter((item) => session.permissions.includes(item.permission)).map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded px-2.5 py-1 text-sm ${
                    active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-600">
            <span>{session.email}</span>
            <button onClick={signOut} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">{children}</main>
    </div>
  );
}
