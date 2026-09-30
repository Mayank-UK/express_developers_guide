import { expect, test } from '@playwright/test';

/**
 * One topic page, rendered end-to-end: the client's generic TopicView turns
 * the served JSON (topic → sections → blocks) into the real DOM. This spec
 * pins the three anatomy facts every topic page promises — sections render,
 * code blocks start COLLAPSED (and expand to the real served source), and
 * the live-demo panels mount.
 */
test('a topic page renders sections, collapsed code, and its live-demo panels', async ({
  page,
}) => {
  await page.goto('/topics/messaging');

  // The served topic title is the page h1. Scoped to the article: the sticky
  // header also renders the (loading-aware) topic title as an h1 in the
  // banner, so the content h1 is the one inside <article>.
  await expect(
    page
      .getByRole('article')
      .getByRole('heading', { level: 1, name: 'Messaging & Event Streaming' }),
  ).toBeVisible();

  // Sections render from the content API.
  await expect(
    page.getByRole('heading', { level: 2, name: 'Why messaging' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'The transactional outbox' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'See it live' }),
  ).toBeVisible();

  // Code blocks start collapsed: the language toggle is aria-expanded=false
  // and the source itself is not in the DOM until clicked.
  const firstTsToggle = page.getByRole('button', { name: 'ts', exact: true }).first();
  await expect(firstTsToggle).toHaveAttribute('aria-expanded', 'false');
  const firstTsSource = page.locator('figure', { has: firstTsToggle }).locator('pre');
  await expect(firstTsSource).toHaveCount(0);

  // Expanding reveals the real served code.
  await firstTsToggle.click();
  await expect(firstTsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(firstTsSource).toBeVisible();
  await expect(firstTsSource).toContainText('XGROUP CREATE with MKSTREAM');

  // The live-demo panels mount (demo bodies lazy-load; the panel headings
  // come from the served content, so they are the stable mount signal).
  await expect(
    page.getByRole('heading', { level: 3, name: 'Stream console' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Outbox console' }),
  ).toBeVisible();
});
