'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useLocale } from '../lib/i18n';
import { useQuery } from '@tanstack/react-query';

const NAV = [
  { href: '/accounts', key: 'nav.accounts', permission: 'ledger.account.read' },
  { href: '/journal', key: 'nav.journal', permission: 'ledger.entry.read' },
  { href: '/inventory', key: 'nav.inventory', permission: 'inventory.read' },
  { href: '/assets', key: 'nav.assets', permission: 'asset.read' },
  { href: '/budget', key: 'nav.budget', permission: 'budget.read' },
  { href: '/close', key: 'nav.close', permission: 'ledger.period.close' },
  { href: '/reports/trial-balance', key: 'nav.trialBalance', permission: 'report.read' },
  { href: '/reports/income-statement', key: 'nav.incomeStatement', permission: 'report.read' },
  { href: '/reports/balance-sheet', key: 'nav.balanceSheet', permission: 'report.read' },
  { href: '/reports/cash-flow', key: 'nav.cashFlow', permission: 'report.read' },
];

interface TenantOption {
  tenantId: string;
  slug: string;
  name: string;
  isHome: boolean;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session, isLoading } = useSession();
  const { t, locale, setLocale } = useLocale();

  const tenants = useQuery({
    queryKey: ['auth-tenants'],
    queryFn: () => api.get<TenantOption[]>('/auth/tenants'),
    enabled: Boolean(session),
  });

  if (pathname === '/login') return <>{children}</>;

  if (isLoading) {
    return <div className="p-8 text-sm text-slate-500">{t('common.loading')}</div>;
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
            {t('app.name')}
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
                  {t(item.key)}
                </Link>
              );
            })}
          </nav>
          <div className="ms-auto flex items-center gap-3 text-xs text-slate-600">
            {/* Switching company reissues the session, so the whole cache goes. */}
            {tenants.data && tenants.data.length > 1 ? (
              <select
                aria-label={t('action.company')}
                value={session.tenantId}
                onChange={async (e) => {
                  await api.post('/auth/switch-tenant', { tenantId: e.target.value });
                  queryClient.clear();
                  router.refresh();
                }}
                className="rounded border border-slate-300 px-2 py-1"
              >
                {tenants.data.map((tenant) => (
                  <option key={tenant.tenantId} value={tenant.tenantId}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}
              className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
            >
              {t('common.language')}
            </button>
            <span>{session.email}</span>
            <button onClick={signOut} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">
              {t('action.signOut')}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">{children}</main>
    </div>
  );
}
