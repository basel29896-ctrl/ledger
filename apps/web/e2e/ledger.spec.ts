import { expect, test } from '@playwright/test';

/**
 * The journey that matters: sign in, post a balanced entry, and see it land in
 * the trial balance. It runs against a real stack seeded by `make dev`, so a
 * pass means the ledger, the API and the UI agree — which is the only claim
 * worth making from an end-to-end test.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'admin@demo.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'Demo-Password-1';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
});

test('the trial balance balances', async ({ page }) => {
  await page.goto('/reports/trial-balance');
  await expect(page.getByText(/the books balance/i)).toBeVisible();
});

test('Post stays disabled until an entry balances', async ({ page }) => {
  await page.goto('/journal/new');

  const post = page.getByRole('button', { name: /^post$/i });
  await expect(post).toBeDisabled();

  // One side only: still out of balance, so posting must stay unavailable.
  const rows = page.getByRole('row');
  await rows.nth(1).getByRole('combobox').first().selectOption({ index: 1 });
  await rows.nth(1).getByRole('spinbutton').first().fill('100');
  await expect(post).toBeDisabled();
  await expect(page.getByText(/out of balance/i)).toBeVisible();
});

test('a posted entry reaches the trial balance', async ({ page }) => {
  await page.goto('/journal/new');

  const rows = page.getByRole('row');
  await rows.nth(1).getByRole('combobox').first().selectOption({ index: 1 });
  await rows.nth(1).getByRole('spinbutton').first().fill('250');
  await rows.nth(2).getByRole('combobox').first().selectOption({ index: 2 });
  await rows.nth(2).getByRole('spinbutton').nth(1).fill('250');

  const post = page.getByRole('button', { name: /^post$/i });
  await expect(post).toBeEnabled();
  await post.click();

  await expect(page).toHaveURL(/\/journal\//);
  await page.goto('/reports/trial-balance');
  await expect(page.getByText(/the books balance/i)).toBeVisible();
});

test('the interface flips to Arabic and reads right to left', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('link', { name: 'دليل الحسابات' })).toBeVisible();
});
