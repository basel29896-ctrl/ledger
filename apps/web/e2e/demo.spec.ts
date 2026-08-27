import { expect, test } from '@playwright/test';

/**
 * The static demo, exercised as a visitor would.
 *
 * This is the only test that runs against the export rather than a live stack,
 * and it guards the claim the demo makes about itself: that the reports are
 * computed from the entries by the real domain code. If posting an entry did
 * not move the trial balance, the demo would be a screenshot with buttons.
 *
 *   pnpm --filter @acct/web build   (with NEXT_PUBLIC_DEMO=1)
 *   npx serve apps/web/out -l 4173
 *   E2E_BASE_URL=http://localhost:4173/ pnpm --filter @acct/web test:e2e:demo
 */

test('the demo opens already signed in', async ({ page }) => {
  // There is no session to establish: the demo answers /auth/me from the
  // captured dataset, so a visitor lands on the dashboard rather than a login.
  await page.goto('./');
  await expect(page.getByRole('link', { name: /journal/i }).first()).toBeVisible();
  await expect(page.getByText('admin@demo.local')).toBeVisible();
});

test('the trial balance balances', async ({ page }) => {
  await page.goto('reports/trial-balance/');
  await expect(page.getByText(/the books balance/i)).toBeVisible();
});

test('a posted entry moves the trial balance', async ({ page }) => {
  await page.goto('reports/trial-balance/');
  const totalsBefore = await page.locator('tfoot').innerText();

  await page.goto('journal/new/');
  const rows = page.getByRole('row');
  await rows.nth(1).getByRole('combobox').first().selectOption({ index: 1 });
  await page.getByLabel('Amount, line 1').fill('250');
  await rows.nth(2).getByRole('combobox').first().selectOption({ index: 2 });
  await page.getByLabel('Amount, line 2').fill('250');

  const post = page.getByRole('button', { name: /post entry/i });
  await expect(post).toBeEnabled();
  await post.click();
  await expect(page).toHaveURL(/\/journal\//);

  await page.goto('reports/trial-balance/');
  await expect(page.getByText(/the books balance/i)).toBeVisible();
  // Totals must have moved: the report is derived from the entries, not stored.
  await expect(page.locator('tfoot')).not.toHaveText(totalsBefore);
});

test('an unbalanced entry cannot be posted', async ({ page }) => {
  await page.goto('journal/new/');
  const post = page.getByRole('button', { name: /post entry/i });
  await expect(post).toBeDisabled();

  await page.getByLabel('Amount, line 1').fill('100');
  await page.getByRole('row').nth(1).getByRole('combobox').first().selectOption({ index: 1 });
  await expect(post).toBeDisabled();
  await expect(page.getByText(/out of balance/i)).toBeVisible();
});

test('the statements render from the captured year', async ({ page }) => {
  await page.goto('reports/income-statement/');
  await expect(page.getByRole('heading', { name: /income statement/i })).toBeVisible();

  await page.goto('reports/balance-sheet/');
  await expect(page.getByRole('heading', { name: /balance sheet/i })).toBeVisible();
});

test('the operational screens carry captured data', async ({ page }) => {
  await page.goto('inventory/');
  await expect(page.getByText('SRV-100')).toBeVisible();

  await page.goto('assets/');
  await expect(page.getByText('FA-0001')).toBeVisible();
});

test('the interface flips to Arabic and reads right to left', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});
