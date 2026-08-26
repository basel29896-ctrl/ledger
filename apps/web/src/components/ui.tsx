'use client';

import { forwardRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

/**
 * A deliberately small set of primitives. The target user is a bookkeeper
 * entering two hundred lines a day, so the styling favours density, aligned
 * numbers and a predictable tab order over decoration.
 *
 * Two rules run through all of it:
 *  - spacing comes from here, not from the screens. Every grid cell is
 *    `px-3 py-1.5` because one screen inventing its own padding is what makes a
 *    product look assembled rather than designed;
 *  - direction-aware properties only (`ms`/`me`, `text-start`/`text-end`), so
 *    the Arabic UI mirrors without a single RTL override.
 */

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const CONTROL =
  'h-8 w-full rounded-md border border-ice-200 bg-surface px-2.5 text-sm text-ink-800 ' +
  'placeholder:text-ink-300 transition-colors outline-none ' +
  'hover:border-ice-300 focus:border-ink-600 focus:ring-2 focus:ring-mint-300 ' +
  'disabled:cursor-not-allowed disabled:bg-ice-50 disabled:text-ink-300';

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  const styles = {
    primary:
      'bg-ink-700 text-mint-100 hover:bg-ink-600 active:bg-ink-800 ' +
      'disabled:bg-ice-200 disabled:text-ink-300',
    secondary:
      'bg-surface text-ink-700 border border-ice-200 hover:border-ink-300 hover:bg-ice-50 ' +
      'disabled:text-ink-300 disabled:hover:bg-surface disabled:hover:border-ice-200',
    ghost: 'text-ink-600 hover:bg-ice-100 disabled:text-ink-300 disabled:hover:bg-transparent',
    danger: 'bg-flag-500 text-white hover:bg-flag-600 disabled:bg-flag-200',
  }[variant];
  const dimensions = size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm';
  return (
    <button
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${dimensions} ${styles} ${className}`}
    />
  );
}

/** Forwards its ref: the journal grid moves focus from row to row. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', type, ...props }, ref) {
    // Amounts are read down a column, so they align right and use lining digits.
    const numeric = type === 'number' ? 'text-end amount' : '';
    return <input {...props} type={type} ref={ref} className={`${CONTROL} ${numeric} ${className}`} />;
  },
);

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} pe-8 ${className}`} />;
}

export function Field({
  label,
  children,
  hint,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1 block text-xs font-medium tracking-wide text-ink-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-400">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/** Every screen opens the same way: title, optional subtitle, actions at the end. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold text-ink-800">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
  padded = true,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Off when the card holds a grid, which brings its own edge-to-edge padding. */
  padded?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-ice-200 bg-surface shadow-[0_1px_2px_rgba(11,34,41,0.04)]">
      {title || actions ? (
        <header className="flex items-center justify-between gap-3 border-b border-ice-200 bg-ice-50 px-4 py-2">
          {title ? (
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">{title}</h2>
          ) : (
            <span />
          )}
          {actions}
        </header>
      ) : null}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

/** The filter strip above a grid. Fields size themselves; actions sit at the end. */
export function Toolbar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-ice-200 bg-surface px-4 py-3">
      <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] items-end gap-3">
        {children}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
  children: ReactNode;
}) {
  const styles = {
    neutral: 'bg-ice-100 text-ink-500',
    good: 'bg-mint-200 text-mint-700',
    warn: 'bg-amber-100 text-amber-600',
    bad: 'bg-flag-100 text-flag-600',
    info: 'bg-ink-700 text-mint-200',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${styles}`}
    >
      {children}
    </span>
  );
}

/**
 * A statement about the books: green when they are sound, amber when something
 * needs a look, red when a number is wrong. Deliberately loud — an out-of-
 * balance ledger should never be a quiet grey line.
 */
export function StatusNote({
  tone,
  children,
}: {
  tone: 'good' | 'warn' | 'bad';
  children: ReactNode;
}) {
  const styles = {
    good: 'border-mint-300 bg-mint-100 text-mint-700',
    warn: 'border-amber-200 bg-amber-100 text-amber-600',
    bad: 'border-flag-200 bg-flag-100 text-flag-600',
  }[tone];
  return (
    <p className={`rounded-md border px-3 py-2 text-sm ${styles}`}>{children}</p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ice-300 bg-surface px-4 py-10 text-center text-sm text-ink-400">
      {children}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const problem = (
    error as {
      problem?: {
        title?: string;
        detail?: string;
        code?: string;
        errors?: { path: string; message: string }[];
      };
    }
  ).problem;
  return (
    <div
      role="alert"
      className="rounded-md border border-flag-200 bg-flag-100 px-3 py-2 text-sm text-flag-600"
    >
      <p className="font-medium">{problem?.title ?? (error as Error).message}</p>
      {problem?.code ? (
        <p className="mt-0.5 font-mono text-xs text-flag-500">{problem.code}</p>
      ) : null}
      {problem?.detail ? <p className="mt-1 text-xs text-ink-600">{problem.detail}</p> : null}
      {problem?.errors?.length ? (
        <ul className="mt-1 list-inside list-disc text-xs text-ink-600">
          {problem.errors.map((e) => (
            <li key={`${e.path}-${e.message}`}>
              <span className="font-mono">{e.path}</span>: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

/**
 * The one table shell. It scrolls horizontally on its own so a wide statement
 * never widens the page, and its header sticks so a long ledger keeps its
 * column names.
 */
export function DataTable({
  children,
  className = '',
  scroll = false,
}: {
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <div
      className={`overflow-x-auto rounded-lg border border-ice-200 bg-surface ${scroll ? 'grid-scroll' : ''} ${className}`}
    >
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-ice-50 text-start text-[11px] uppercase tracking-wider text-ink-500">
      {children}
    </thead>
  );
}

export function Th({
  numeric = false,
  className = '',
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      {...props}
      scope={props.scope ?? 'col'}
      className={`border-b border-ice-200 px-3 py-2 font-medium ${numeric ? 'text-end' : 'text-start'} ${className}`}
    >
      {children}
    </th>
  );
}

export function Tr({
  children,
  interactive = false,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      {...props}
      className={`border-b border-ice-100 last:border-0 ${
        interactive ? 'cursor-pointer transition-colors hover:bg-mint-100' : 'hover:bg-ice-50'
      } ${className}`}
    >
      {children}
    </tr>
  );
}

export function Td({
  numeric = false,
  mono = false,
  muted = false,
  className = '',
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; mono?: boolean; muted?: boolean }) {
  return (
    <td
      {...props}
      className={`px-3 py-1.5 align-middle ${numeric ? 'text-end amount' : 'text-start'} ${
        mono ? 'font-mono text-xs' : ''
      } ${muted ? 'text-ink-400' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

/** The totals row. One rule above it, one weight heavier, ice behind it. */
export function TFoot({ children }: { children: ReactNode }) {
  return <tfoot className="border-t-2 border-ink-200 bg-ice-50 font-medium">{children}</tfoot>;
}

/** A labelled band inside a statement — "Current assets", "Revenue". */
export function SectionRow({ label, colSpan = 3 }: { label: string; colSpan?: number }) {
  return (
    <tr className="bg-ice-50">
      <th
        colSpan={colSpan}
        scope="colgroup"
        className="border-y border-ice-200 px-3 py-1.5 text-start text-[11px] font-semibold uppercase tracking-wider text-ink-500"
      >
        {label}
      </th>
    </tr>
  );
}

export function LoadingRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-ink-400">
        Loading…
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function Money({
  value,
  bold = false,
  className = '',
}: {
  value: { amount: string } | null | undefined;
  bold?: boolean;
  className?: string;
}) {
  if (!value) return <span className="text-ink-300">—</span>;
  const negative = value.amount.startsWith('-');
  return (
    <span
      className={`amount ${bold ? 'font-semibold' : ''} ${
        negative ? 'text-flag-500' : 'text-ink-800'
      } ${className}`}
    >
      {value.amount}
    </span>
  );
}

/** A headline figure on the dashboard: the number first, its label under it. */
export function Stat({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const noteTone = {
    neutral: 'text-ink-400',
    good: 'text-mint-700',
    warn: 'text-amber-600',
    bad: 'text-flag-500',
  }[tone];
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-ink-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink-800">{value}</p>
      {note ? <p className={`mt-1 text-xs ${noteTone}`}>{note}</p> : null}
    </div>
  );
}
