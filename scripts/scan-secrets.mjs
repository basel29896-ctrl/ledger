#!/usr/bin/env node
/*
 * Commit-time secret scan.
 *
 * Deliberately small and fast: it runs on staged files so a credential is
 * caught before it enters history, where removing it means rewriting the repo
 * and rotating the key anyway. Gitleaks runs the deeper scan in CI; this is the
 * cheap guard that catches the common paste.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // `${VAR}` is an environment reference, not a credential, and compose files
  // are full of them; excluding it here keeps the rule itself honest.
  {
    name: 'connection string with password',
    re: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/$]+:(?!\$\{)[^\s:@/]+@/,
  },
  /*
   * An assigned literal only counts when it looks like a real credential. A
   * value made only of lowercase words and hyphens — `wrong-password`,
   * `audit-secret` — is a fixture, and flagging those teaches people to ignore
   * the scanner, which is worse than not running one.
   */
  {
    name: 'assigned secret literal',
    re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*['"](?![a-z-]+['"])[^'"\s]{12,}['"]/i,
  },
];

/*
 * Fixtures and examples are allowed to contain obvious placeholders: a test
 * password that is clearly fake is not a leak, and flagging it trains people to
 * ignore the scanner.
 */
const ALLOWED_PATHS = [/\.env\.example$/, /(^|\/)docs\//, /(^|\/)scripts\/scan-secrets\.mjs$/];
const ALLOWED_VALUES = [
  /minioadmin/i,
  /Correct-Horse-Battery-9/,
  /test-(access|refresh)-secret-that-is-long-enough-32/,
  /postgres(ql)?:\/\/(test|owner|accounting|acct_app_user):[^@]*@/,
  /Demo-Password-1/,
  /changeme|placeholder|example|your[-_]/i,
];

const staged = process.argv.includes('--all')
  ? execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  : execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8' });

const files = staged.split('\n').map((f) => f.trim()).filter(Boolean);
const findings = [];

for (const file of files) {
  if (ALLOWED_PATHS.some((re) => re.test(file))) continue;
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > 2_000_000) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable: nothing to read as text
  }

  content.split('\n').forEach((line, index) => {
    if (ALLOWED_VALUES.some((re) => re.test(line))) return;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push({ file, line: index + 1, name });
    }
  });
}

if (findings.length > 0) {
  console.error('Possible secrets found. Nothing was committed.\n');
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.name}`);
  console.error('\nMove the value to the environment. If this is a false positive, add a narrow');
  console.error('exception in scripts/scan-secrets.mjs and say why in the commit message.');
  process.exit(1);
}

console.log(`scan:secrets — ${files.length} file(s) checked, nothing found.`);
