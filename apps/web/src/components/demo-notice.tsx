'use client';

import { useEffect, useState } from 'react';
import { DEMO } from '../lib/demo-flag';

/**
 * The demo's honesty label.
 *
 * A demo that does not say what it is invites people to draw conclusions it
 * cannot support — that the numbers are live, that the data is theirs, that the
 * invariants are being enforced in front of them. This says plainly which parts
 * are really being computed and which are replayed, and it stays on screen
 * rather than hiding behind a tooltip.
 */
export function DemoNotice() {
  const [open, setOpen] = useState(false);

  // Whether the explanation was expanded is a per-visitor convenience, so it is
  // remembered locally and never allowed to break the page if storage is barred.
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem('demo-notice') !== 'collapsed');
    } catch {
      setOpen(true);
    }
  }, []);

  if (!DEMO) return null;

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem('demo-notice', next ? 'expanded' : 'collapsed');
    } catch {
      /* A visitor who blocks storage still gets a working page. */
    }
  };

  return (
    <div className="border-b border-ink-700/60 bg-ink-800 text-ice-100">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6">
        <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-800">
          Demo
        </span>
        <p className="text-xs text-ice-100/90">
          The whole application, running in your browser. No server, no database — nothing you
          type here leaves this tab or survives a reload.
        </p>
        <button
          type="button"
          onClick={toggle}
          className="ms-auto rounded px-2 py-0.5 text-xs font-medium text-mint-300 underline-offset-2 hover:underline"
          aria-expanded={open}
        >
          {open ? 'Hide details' : 'What is real here?'}
        </button>
      </div>

      {open ? (
        <div className="grid gap-4 border-t border-ink-700/60 px-4 py-3 text-xs leading-relaxed sm:grid-cols-2 sm:px-6">
          <div>
            <p className="mb-1 font-semibold text-mint-300">Computed live, by the real code</p>
            <p className="text-ice-100/80">
              The trial balance, general ledger, income statement, balance sheet and cash flow
              statement are all derived from the journal by the same <code>@acct/domain</code>{' '}
              package the server uses — decimal arithmetic on integer minor units, never floats.
              Post an entry and every report moves. An entry that does not balance cannot be
              posted, because that rule lives in the domain layer too.
            </p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-amber-400">Replayed from a captured dataset</p>
            <p className="text-ice-100/80">
              Inventory costing, depreciation schedules, budget variance and period-close state
              are shown exactly as the real API returned them. Those run inside a database
              transaction — FIFO cost layers, the once-per-asset-per-period constraint — so the
              demo replays the result rather than writing a second implementation that would
              drift. Buttons that would need the server say so instead of pretending.
            </p>
          </div>
          <p className="text-ice-100/70 sm:col-span-2">
            None of the database-level invariants are enforced here: no triggers, no constraints,
            no row-level security, no immutability of posted entries. Those are the server&apos;s
            job, and a static page cannot stand in for them.{' '}
            <a
              className="text-mint-300 underline underline-offset-2"
              href="https://github.com/basel29896-ctrl/ledger"
            >
              Read the source
            </a>{' '}
            or{' '}
            <a
              className="text-mint-300 underline underline-offset-2"
              href="https://basel29896-ctrl.github.io/ledger/docs/"
            >
              the design notes
            </a>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}
