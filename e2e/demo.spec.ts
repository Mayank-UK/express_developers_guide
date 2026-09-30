import { expect, test } from '@playwright/test';

/**
 * The one full round-trip through the real stack: browser → Vite dev server
 * → /api proxy → Express server → back, asserted on what the user sees.
 *
 * Topic: SQL and Schema Design → "Key strategy: UUIDv7 vs sequential". The
 * demo mints its two id batches SERVER-SIDE; the count echo, both sort
 * verdicts, and the panel headings below render only from the server's JSON
 * response — none of that text exists in the client bundle — so the spec
 * passes only if the whole wire works.
 */
test('the uuid strategy demo answers from the real server', async ({ page }) => {
  await page.goto('/topics/sql-schema');
  // Scoped to the article: the sticky header renders the topic title as an
  // h1 too (banner), so assert on the content h1.
  await expect(
    page
      .getByRole('article')
      .getByRole('heading', { level: 1, name: 'SQL and Schema Design' }),
  ).toBeVisible();

  // The live panel for demoId db:uuid — demos are lazy-loaded chunks, so
  // waiting for its heading also waits for the chunk to mount.
  await expect(
    page.getByRole('heading', { level: 3, name: 'v4 vs v7: watch the sort decide' }),
  ).toBeVisible();

  // A non-default batch size, so the echoed count proves the query param
  // actually traveled to the server and came back.
  await page.getByLabel('batch size').selectOption('24');
  await page.getByRole('button', { name: 'generate both batches' }).click();

  // Server-backed outcomes: the count echo and both sort verdicts are fields
  // of the server's response body, rendered by the demo only after the
  // round-trip completes.
  await expect(page.getByText('24 ids per side', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'UUID v4 — random' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'UUID v7 — time-ordered' })).toBeVisible();
  await expect(page.getByText('sorted ≠ generated', { exact: true })).toBeVisible();
  await expect(page.getByText('sorted === generated', { exact: true })).toBeVisible();
});
