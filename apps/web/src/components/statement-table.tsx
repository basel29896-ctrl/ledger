'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { StatementSection } from '@acct/domain';
import { Money } from './ui';

/**
 * A statement section rendered as a dense grid. Every account line links to its
 * general ledger, so a figure on a statement reaches its postings in one click.
 */
export function SectionRows({
  section,
  fromDate,
  toDate,
}: {
  section: StatementSection;
  fromDate?: string;
  toDate?: string;
}) {
  const range = `${fromDate ? `&fromDate=${fromDate}` : ''}${toDate ? `&toDate=${toDate}` : ''}`;
  return (
    <>
      <tr className="border-b border-slate-200 bg-slate-50">
        <th colSpan={3} className="px-3 py-1.5 text-left text-xs font-medium uppercase text-slate-600">
          {section.label}
        </th>
      </tr>
      {section.lines.map((line) => (
        <tr key={`${section.key}-${line.accountId}`} className="border-b border-slate-100 hover:bg-slate-50">
          <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{line.code}</td>
          <td className="px-3 py-1.5">
            {line.code ? (
              <Link href={`/reports/general-ledger?accountId=${line.accountId}${range}`} className="underline">
                {line.name}
              </Link>
            ) : (
              line.name
            )}
          </td>
          <td className="px-3 py-1.5 text-right">
            <Money value={line.amount} />
          </td>
        </tr>
      ))}
      <tr className="border-b border-slate-300">
        <td colSpan={2} className="px-3 py-1.5 text-right text-xs uppercase text-slate-600">
          Total {section.label}
        </td>
        <td className="px-3 py-1.5 text-right">
          <Money value={section.total} bold />
        </td>
      </tr>
    </>
  );
}

export function TotalRow({ label, value }: { label: string; value: { amount: string } }) {
  return (
    <tr className="border-b-2 border-slate-400 bg-slate-100">
      <td colSpan={2} className="px-3 py-2 text-right text-sm font-semibold">
        {label}
      </td>
      <td className="px-3 py-2 text-right">
        <Money value={value} bold />
      </td>
    </tr>
  );
}

export function StatementTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
