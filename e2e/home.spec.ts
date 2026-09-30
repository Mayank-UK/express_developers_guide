import { expect, test } from '@playwright/test';

/** The 10 group titles the content API serves — the home hub shows them all. */
const GROUP_TITLES = [
  'Fundamentals',
  'Middleware & Request Handling',
  'APIs',
  'Data',
  'Caching & Messaging',
  'Auth & Security',
  'Files & Media',
  'Internationalization',
  'Real-time & Jobs',
  'Platform',
] as const;

/**
 * Home is the guide's nav hub: a hero, run instructions, and the topic map
 * fetched live from GET /api/content. This spec pins that the map actually
 * renders in a real browser — every group, and every topic as a populated
 * link card (40 today), including the two newest topics.
 */
test('the home hub renders the full topic map', async ({ page }) => {
  await page.goto('/');

  // Scoped to the main region: the sticky header also renders the route
  // title as an h1 (banner), so the page-level h1 is the one inside <main>.
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { level: 1, name: 'Express Developers Guide' }),
  ).toBeVisible();

  // The map arrives from the content API — wait for the real section to
  // replace the loading skeleton.
  const topicMap = page.locator('#topic-map');
  await expect(topicMap).toBeVisible();

  for (const title of GROUP_TITLES) {
    await expect(topicMap.getByText(title, { exact: true })).toBeVisible();
  }

  // Every topic card is a populated link (not a "soon" tile) — 40 today.
  // The count pins the map's completeness; a dropped or doubled topic
  // fails here.
  await expect(topicMap.getByRole('link')).toHaveCount(40);

  // Spot checks, including the two newest topics.
  await expect(
    topicMap.getByRole('link', { name: /Messaging & Event Streaming/ }),
  ).toBeVisible();
  await expect(
    topicMap.getByRole('link', { name: /Advanced Architecture/ }),
  ).toBeVisible();
  await expect(
    topicMap.getByRole('link', { name: /SQL and Schema Design/ }),
  ).toBeVisible();
  await expect(topicMap.getByRole('link', { name: /^Testing/ })).toBeVisible();
});
