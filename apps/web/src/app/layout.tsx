import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Accounting', description: 'Double-entry accounting platform' };

export default function RootLayout({ children }: { children: ReactNode }) {
  // `dir` becomes dynamic in M12 when the Arabic locale lands.
  return (
    <html lang="en" dir="ltr">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
