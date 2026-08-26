import type { ReactNode } from 'react';
import { Providers } from '../components/providers';
import { Shell } from '../components/shell';
import './globals.css';

export const metadata = {
  title: 'Accounting',
  description: 'Double-entry accounting platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  /*
   * `lang` and `dir` start as English and are rewritten by the locale provider
   * on the client. Doing it on the document element means the whole tree flips
   * for Arabic, rather than each screen remembering to.
   */
  return (
    <html lang="en" dir="ltr">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
