import type { ReactNode } from 'react';
import { Providers } from '../components/providers';
import { Shell } from '../components/shell';
import './globals.css';

export const metadata = {
  title: 'Accounting',
  description: 'Double-entry accounting platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // `dir` becomes locale-driven in M12 when the Arabic UI lands.
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
