'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Localisation, English and Arabic.
 *
 * Arabic is right-to-left, which is a layout concern, not a translation one:
 * the direction is set on the document element so the whole tree flips, rather
 * than each screen trying to remember. Numbers stay in Western digits and money
 * keeps its own formatting — a fils is a fils in either language, and switching
 * numerals in an accounting screen invites transcription mistakes.
 */

export type Locale = 'en' | 'ar';

const DICTIONARY: Record<string, { en: string; ar: string }> = {
  'app.name': { en: 'Accounting', ar: 'المحاسبة' },
  'nav.group.ledger': { en: 'Ledger', ar: 'الدفاتر' },
  'nav.group.operations': { en: 'Operations', ar: 'العمليات' },
  'nav.group.reports': { en: 'Reports', ar: 'التقارير' },
  'nav.accounts': { en: 'Chart of Accounts', ar: 'دليل الحسابات' },
  'nav.journal': { en: 'Journal', ar: 'القيود' },
  'nav.inventory': { en: 'Inventory', ar: 'المخزون' },
  'nav.assets': { en: 'Fixed Assets', ar: 'الأصول الثابتة' },
  'nav.budget': { en: 'Budget', ar: 'الموازنة' },
  'nav.close': { en: 'Period Close', ar: 'إقفال الفترة' },
  'nav.trialBalance': { en: 'Trial Balance', ar: 'ميزان المراجعة' },
  'nav.incomeStatement': { en: 'P&L', ar: 'الأرباح والخسائر' },
  'nav.balanceSheet': { en: 'Balance Sheet', ar: 'الميزانية العمومية' },
  'nav.cashFlow': { en: 'Cash Flow', ar: 'التدفقات النقدية' },
  'action.signOut': { en: 'Sign out', ar: 'تسجيل الخروج' },
  'action.company': { en: 'Company', ar: 'الشركة' },
  'common.loading': { en: 'Loading…', ar: 'جارٍ التحميل…' },
  'common.language': { en: 'العربية', ar: 'English' },
};

interface LocaleContextValue {
  locale: Locale;
  direction: 'ltr' | 'rtl';
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);
const STORAGE_KEY = 'acct.locale';

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'ar' || stored === 'en') setLocaleState(stored);
    } catch {
      // A browser with storage blocked still gets a working UI, in English.
    }
  }, []);

  const direction = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
  }, [locale, direction]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference is per-session if it cannot be stored; not worth failing over.
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      direction,
      setLocale,
      // An unknown key shows itself rather than an empty space, so a missing
      // translation is obvious in review instead of silently blank on screen.
      t: (key: string) => DICTIONARY[key]?.[locale] ?? key,
    }),
    [locale, direction, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used inside LocaleProvider');
  return context;
}
