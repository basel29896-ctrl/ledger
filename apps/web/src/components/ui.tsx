'use client';

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/**
 * A deliberately small set of primitives. The target user is a bookkeeper
 * entering two hundred lines a day, so the styling favours density and a
 * predictable tab order over decoration.
 */

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300',
    secondary: 'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-700 text-white hover:bg-red-600 disabled:bg-red-200',
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex h-8 items-center rounded px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

/** Forwards its ref: the journal grid moves focus from row to row. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={`h-8 w-full rounded border border-slate-300 px-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900 ${className}`}
      />
    );
  },
);

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900 ${className}`}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded border border-slate-200 bg-white">
      {title || actions ? (
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
          {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const problem = (error as { problem?: { title?: string; detail?: string; code?: string; errors?: { path: string; message: string }[] } }).problem;
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
      <p className="font-medium">{problem?.title ?? (error as Error).message}</p>
      {problem?.code ? <p className="mt-0.5 font-mono text-xs text-red-700">{problem.code}</p> : null}
      {problem?.detail ? <p className="mt-1 text-xs">{problem.detail}</p> : null}
      {problem?.errors?.length ? (
        <ul className="mt-1 list-inside list-disc text-xs">
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

export function Money({ value, bold = false }: { value: { amount: string } | null | undefined; bold?: boolean }) {
  if (!value) return <span className="text-slate-400">—</span>;
  const negative = value.amount.startsWith('-');
  return (
    <span
      className={`tabular-nums ${bold ? 'font-semibold' : ''} ${negative ? 'text-red-700' : 'text-slate-900'}`}
    >
      {value.amount}
    </span>
  );
}
