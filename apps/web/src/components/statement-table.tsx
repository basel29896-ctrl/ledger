'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { StatementSection } from '@acct/domain';
import { Money, Td, Tr } from './ui';

/**
 * A statement section rendered as a dense grid. Every account line links to its
 * general ledger, so a figure on a statement reaches its postings in one click.
 *
 * Indentation carries the hierarchy: the section band sits flush, its lines are
 * indented one step, and the section total returns to the band's indent so the
 * eye can find it without a rule under every row.
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
      <tr className="bg-ice-50">
        <th
          colSpan={3}
          scope="colgroup"
          className="border-y border-ice-200 px-3 py-1.5 text-start text-[11px] font-semibold uppercase tracking-wider text-ink-500"
        >
          {section.label}
        </th>
      </tr>
      {section.lines.map((line) => (
        <Tr key={`${section.key}-${line.accountId}`}>
          <Td mono muted className="w-24">
            {line.code}
          </Td>
          <Td className="ps-6">
            {line.code ? (
              <Link
                href={`/reports/general-ledger?accountId=${line.accountId}${range}`}
                className="text-ink-700 underline decoration-ice-300 underline-offset-2 hover:decoration-ink-400"
              >
                {line.name}
              </Link>
            ) : (
              <span className="text-ink-500 italic">{line.name}</span>
            )}
          </Td>
          <Td numeric className="w-44">
            <Money value={line.amount} />
          </Td>
        </Tr>
      ))}
      <tr className="border-b border-ice-200 bg-surface">
        <Td colSpan={2} className="text-end text-xs font-medium text-ink-500">
          Total {section.label}
        </Td>
        <Td numeric>
          <Money value={section.total} bold />
        </Td>
      </tr>
    </>
  );
}

/** A subtotal that carries weight: gross profit, total assets, net movement. */
export function TotalRow({
  label,
  value,
  emphasis = 'normal',
}: {
  label: string;
  value: { amount: string };
  emphasis?: 'normal' | 'strong';
}) {
  return (
    <tr
      className={
        emphasis === 'strong'
          ? 'border-y-2 border-ink-700 bg-ink-800 text-mint-100'
          : 'border-y border-ink-200 bg-ice-100'
      }
    >
      <td
        colSpan={2}
        className={`px-3 py-2 text-end text-sm font-semibold ${
          emphasis === 'strong' ? 'text-mint-100' : 'text-ink-700'
        }`}
      >
        {label}
      </td>
      <td className="amount px-3 py-2 text-end">
        {emphasis === 'strong' ? (
          <span className="font-semibold text-mint-200">{value.amount}</span>
        ) : (
          <Money value={value} bold />
        )}
      </td>
    </tr>
  );
}

export function StatementTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ice-200 bg-surface">
      <table className="w-full text-sm">
        <colgroup>
          <col className="w-24" />
          <col />
          <col className="w-44" />
        </colgroup>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
