/**
 * Bank statement matching.
 *
 * Four passes, in order of confidence:
 *   1. exact   — same amount, same date, and a reference that agrees;
 *   2. amount+date — same amount inside a date window;
 *   3. fuzzy   — same amount, wider window, description similarity;
 *   4. rules   — a tenant rule that says what an unmatched line is.
 *
 * Anything the passes cannot decide is left for a human. A wrong automatic
 * match is far more expensive than an unmatched line, so the thresholds are
 * deliberately conservative and every suggestion carries its score and reason.
 */

export interface StatementLineForMatch {
  readonly id: string;
  readonly bookingDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly counterparty: string | null;
  readonly amountMinor: bigint;
}

export interface LedgerCandidate {
  /** The journal entry or payment this candidate stands for. */
  readonly id: string;
  readonly kind: 'payment' | 'journal_entry';
  readonly date: string;
  readonly description: string;
  readonly reference: string | null;
  readonly counterpartyName: string | null;
  /** Signed the same way as the statement: positive is money into the bank. */
  readonly amountMinor: bigint;
}

export type MatchConfidence = 'exact' | 'high' | 'probable' | 'rule';

export interface MatchSuggestion {
  readonly statementLineId: string;
  readonly candidateId: string;
  readonly candidateKind: LedgerCandidate['kind'];
  readonly confidence: MatchConfidence;
  /** 0–100. Only used to rank suggestions within a pass. */
  readonly score: number;
  readonly reason: string;
}

export interface MatchOptions {
  /** Days either side for the amount+date pass. */
  readonly exactWindowDays?: number;
  /** Days either side for the fuzzy pass. */
  readonly fuzzyWindowDays?: number;
  /** 0–1 description similarity needed for a fuzzy match. */
  readonly minimumSimilarity?: number;
}

const DEFAULTS = { exactWindowDays: 3, fuzzyWindowDays: 10, minimumSimilarity: 0.6 } as const;

function daysApart(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((left - right) / 86_400_000));
}

/** Letters and digits only, lower-cased: bank formatting is not signal. */
export function normalise(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Token-based similarity (Dice coefficient over character bigrams).
 * Chosen over edit distance because bank descriptions reorder words far more
 * often than they misspell them.
 */
export function similarity(a: string, b: string): number {
  const left = normalise(a);
  const right = normalise(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;

  const bigrams = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < text.length - 1; i += 1) {
      const pair = text.slice(i, i + 2);
      map.set(pair, (map.get(pair) ?? 0) + 1);
    }
    return map;
  };

  const first = bigrams(left);
  const second = bigrams(right);
  let shared = 0;
  for (const [pair, count] of first) {
    const other = second.get(pair);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (left.length - 1 + (right.length - 1));
}

/** True when either reference appears inside the other, once normalised. */
export function referencesAgree(a: string | null, b: string | null): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (left.length < 3 || right.length < 3) return false;
  return left.includes(right) || right.includes(left);
}

export function suggestMatches(
  lines: readonly StatementLineForMatch[],
  candidates: readonly LedgerCandidate[],
  options: MatchOptions = {},
): readonly MatchSuggestion[] {
  const exactWindow = options.exactWindowDays ?? DEFAULTS.exactWindowDays;
  const fuzzyWindow = options.fuzzyWindowDays ?? DEFAULTS.fuzzyWindowDays;
  const minimumSimilarity = options.minimumSimilarity ?? DEFAULTS.minimumSimilarity;

  const suggestions: MatchSuggestion[] = [];
  const takenCandidates = new Set<string>();
  const matchedLines = new Set<string>();

  const commit = (suggestion: MatchSuggestion): void => {
    suggestions.push(suggestion);
    takenCandidates.add(suggestion.candidateId);
    matchedLines.add(suggestion.statementLineId);
  };

  // Pass 1 — amount, date and reference all agree.
  for (const line of lines) {
    for (const candidate of candidates) {
      if (takenCandidates.has(candidate.id)) continue;
      if (candidate.amountMinor !== line.amountMinor) continue;
      if (daysApart(line.bookingDate, candidate.date) > exactWindow) continue;
      // The reference may be a field on the candidate, or written into its
      // description — a manual posting has nowhere else to put it.
      const referenceMatch =
        referencesAgree(line.reference, candidate.reference) ||
        (line.reference !== null &&
          normalise(line.reference).length >= 3 &&
          normalise(candidate.description).includes(normalise(line.reference)));
      if (!referenceMatch) continue;
      commit({
        statementLineId: line.id,
        candidateId: candidate.id,
        candidateKind: candidate.kind,
        confidence: 'exact',
        score: 100,
        reason: `Amount, date and reference all agree (${line.reference})`,
      });
      break;
    }
  }

  // Pass 2 — amount and date agree, exactly one candidate fits.
  for (const line of lines) {
    if (matchedLines.has(line.id)) continue;
    const fits = candidates.filter(
      (c) =>
        !takenCandidates.has(c.id) &&
        c.amountMinor === line.amountMinor &&
        daysApart(line.bookingDate, c.date) <= exactWindow,
    );
    if (fits.length === 1) {
      const candidate = fits[0]!;
      commit({
        statementLineId: line.id,
        candidateId: candidate.id,
        candidateKind: candidate.kind,
        confidence: 'high',
        score: 90,
        reason: `Exact amount within ${exactWindow} days, and the only candidate that fits`,
      });
    }
  }

  // Pass 3 — amount agrees in a wider window; the description decides.
  for (const line of lines) {
    if (matchedLines.has(line.id)) continue;
    const scored = candidates
      .filter(
        (c) =>
          !takenCandidates.has(c.id) &&
          c.amountMinor === line.amountMinor &&
          daysApart(line.bookingDate, c.date) <= fuzzyWindow,
      )
      .map((candidate) => {
        const descriptionScore = similarity(line.description, candidate.description);
        const partyScore = similarity(
          line.counterparty ?? line.description,
          candidate.counterpartyName ?? candidate.description,
        );
        return { candidate, score: Math.max(descriptionScore, partyScore) };
      })
      .filter((entry) => entry.score >= minimumSimilarity)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const runnerUp = scored[1];
    // Refuse when two candidates are almost equally plausible: a coin-flip
    // match is worse than leaving the line for a person.
    if (best && (!runnerUp || best.score - runnerUp.score >= 0.1)) {
      commit({
        statementLineId: line.id,
        candidateId: best.candidate.id,
        candidateKind: best.candidate.kind,
        confidence: 'probable',
        score: Math.round(best.score * 80),
        reason: `Exact amount within ${fuzzyWindow} days and a ${(best.score * 100).toFixed(0)}% description match`,
      });
    }
  }

  return suggestions;
}

// --- bank rules --------------------------------------------------------

export interface BankRule {
  readonly id: string;
  readonly priority: number;
  /** All conditions must hold. */
  readonly descriptionContains?: string | null;
  readonly referenceContains?: string | null;
  readonly minAmountMinor?: bigint | null;
  readonly maxAmountMinor?: bigint | null;
  readonly direction?: 'in' | 'out' | null;
  /** What to do when it matches. */
  readonly accountId: string;
  readonly contactId?: string | null;
  readonly taxCodeId?: string | null;
  readonly description?: string | null;
}

export interface RuleMatch {
  readonly statementLineId: string;
  readonly rule: BankRule;
}

export function applyRules(
  line: StatementLineForMatch,
  rules: readonly BankRule[],
): RuleMatch | null {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  for (const rule of ordered) {
    if (rule.descriptionContains) {
      if (!normalise(line.description).includes(normalise(rule.descriptionContains))) continue;
    }
    if (rule.referenceContains) {
      if (!normalise(line.reference).includes(normalise(rule.referenceContains))) continue;
    }
    if (rule.direction === 'in' && line.amountMinor <= 0n) continue;
    if (rule.direction === 'out' && line.amountMinor >= 0n) continue;

    const magnitude = line.amountMinor < 0n ? -line.amountMinor : line.amountMinor;
    if (rule.minAmountMinor !== null && rule.minAmountMinor !== undefined) {
      if (magnitude < rule.minAmountMinor) continue;
    }
    if (rule.maxAmountMinor !== null && rule.maxAmountMinor !== undefined) {
      if (magnitude > rule.maxAmountMinor) continue;
    }
    return { statementLineId: line.id, rule };
  }
  return null;
}

// --- reconciliation ----------------------------------------------------

export interface ReconciliationInput {
  /** Closing balance the bank states. */
  readonly statementClosingMinor: bigint;
  /** Balance of the GL bank account at the same date. */
  readonly ledgerBalanceMinor: bigint;
  /** Statement lines not yet matched to the ledger. */
  readonly unmatchedStatementMinor: bigint;
  /** Ledger entries not yet on the statement (in transit). */
  readonly unmatchedLedgerMinor: bigint;
}

export interface ReconciliationResult {
  readonly statementClosingMinor: bigint;
  readonly ledgerBalanceMinor: bigint;
  readonly adjustedLedgerMinor: bigint;
  readonly differenceMinor: bigint;
  readonly reconciled: boolean;
}

/**
 * The reconciliation identity:
 *
 *   ledger balance + statement lines not yet booked
 *                 + ledger entries not yet on the statement
 *                 = statement closing balance
 *
 * A session may only be completed when the difference is exactly zero.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const adjusted =
    input.ledgerBalanceMinor + input.unmatchedStatementMinor + input.unmatchedLedgerMinor;
  const difference = input.statementClosingMinor - adjusted;
  return {
    statementClosingMinor: input.statementClosingMinor,
    ledgerBalanceMinor: input.ledgerBalanceMinor,
    adjustedLedgerMinor: adjusted,
    differenceMinor: difference,
    reconciled: difference === 0n,
  };
}
