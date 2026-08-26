'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useLocale } from '../lib/i18n';

/**
 * The application frame: a dark rail for navigation, a light canvas for the
 * numbers. Grouping the destinations matters more than it looks — a bookkeeper
 * reaches for "the ledger" or "the reports", not for an alphabetical list of
 * fourteen links.
 */
const NAV: { group: string; items: { href: string; key: string; permission: string }[] }[] = [
  {
    group: 'nav.group.ledger',
    items: [
      { href: '/accounts', key: 'nav.accounts', permission: 'ledger.account.read' },
      { href: '/journal', key: 'nav.journal', permission: 'ledger.entry.read' },
      { href: '/close', key: 'nav.close', permission: 'ledger.period.close' },
    ],
  },
  {
    group: 'nav.group.operations',
    items: [
      { href: '/inventory', key: 'nav.inventory', permission: 'inventory.read' },
      { href: '/assets', key: 'nav.assets', permission: 'asset.read' },
      { href: '/budget', key: 'nav.budget', permission: 'budget.read' },
    ],
  },
  {
    group: 'nav.group.reports',
    items: [
      { href: '/reports/trial-balance', key: 'nav.trialBalance', permission: 'report.read' },
      { href: '/reports/income-statement', key: 'nav.incomeStatement', permission: 'report.read' },
      { href: '/reports/balance-sheet', key: 'nav.balanceSheet', permission: 'report.read' },
      { href: '/reports/cash-flow', key: 'nav.cashFlow', permission: 'report.read' },
    ],
  },
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
    return <div className="p-8 text-sm text-ink-400">{t('common.loading')}</div>;
  }

  if (!session) {
    return (
      <div className="p-8 text-sm">
        <p className="text-ink-600">You are not signed in.</p>
        <Link href="/login" className="mt-2 inline-block font-medium text-ink-700 underline">
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

  const visible = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => session.permissions.includes(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* The rail. Dark, so the grid beside it reads as the working surface. */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-e border-ink-900 bg-ink-800 lg:flex">
        <Link
          href="/"
          className="flex h-14 items-center gap-2.5 border-b border-ink-700/60 px-4 text-mint-100"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-mint-300 text-sm font-bold text-ink-800">
            ٧
          </span>
          <span className="text-sm font-semibold tracking-tight">{t('app.name')}</span>
        </Link>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {visible.map((group) => (
            <div key={group.group} className="mb-4">
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">
                {t(group.group)}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                          active
                            ? 'bg-mint-300 font-medium text-ink-800'
                            : 'text-ink-100/80 hover:bg-ink-700 hover:text-mint-100'
                        }`}
                      >
                        {t(item.key)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-700/60 px-4 py-3 text-[11px] text-ink-300">
          <p className="truncate">{session.email}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ice-200 bg-surface/95 px-4 backdrop-blur">
          {/* Narrow screens lose the rail, so the links come back as a scroller. */}
          <nav className="flex gap-1 overflow-x-auto lg:hidden">
            {visible.flatMap((group) => group.items).map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`whitespace-nowrap rounded-md px-2.5 py-1 text-sm ${
                    active ? 'bg-ink-700 text-mint-100' : 'text-ink-600 hover:bg-ice-100'
                  }`}
                >
                  {t(item.key)}
                </Link>
              );
            })}
          </nav>

          <div className="ms-auto flex items-center gap-2 text-xs">
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
                className="h-8 rounded-md border border-ice-200 bg-surface px-2 pe-7 text-xs text-ink-700 outline-none hover:border-ink-300 focus:border-ink-600 focus:ring-2 focus:ring-mint-300"
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
              className="h-8 rounded-md border border-ice-200 px-2.5 font-medium text-ink-600 transition-colors hover:border-ink-300 hover:bg-ice-50"
            >
              {t('common.language')}
            </button>
            <button
              onClick={signOut}
              className="h-8 rounded-md border border-ice-200 px-2.5 font-medium text-ink-600 transition-colors hover:border-flag-200 hover:bg-flag-100 hover:text-flag-600"
            >
              {t('action.signOut')}
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[110rem] flex-1 space-y-4 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
