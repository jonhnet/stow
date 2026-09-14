import { test, expect, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const archivedRegion = (page: Page) => page.getByRole('region', { name: 'Archived notes', exact: true });

async function createNote(page: Page, title: string, body: string, label?: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await creationEditor.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const text = creationEditor.getByRole('textbox', { name: 'Note text', exact: true });
  await text.focus();
  await text.fill(body);
  if (label) {
    await creationEditor.getByRole('button', { name: 'Edit labels', exact: true }).click();
    const picker = creationEditor.getByRole('group', { name: 'Edit labels', exact: true });
    await picker.getByRole('textbox', { name: 'Find or create label', exact: true }).fill(label);
    const existing = picker.getByRole('checkbox', { name: label, exact: true });
    if (await existing.count()) await existing.check();
    else await picker.getByRole('button', { name: `Create label “${label}”`, exact: true }).click();
    await expect(picker.getByRole('checkbox', { name: label, exact: true })).toBeChecked();
    await picker.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title)).toBeVisible();
}

async function pin(page: Page, title: string) {
  await card(page, title).hover();
  await card(page, title).getByRole('button', { name: 'Pin note', exact: true }).click();
  await expect(card(page, title).getByRole('button', { name: 'Unpin note', exact: true })).toBeVisible();
}

async function archive(page: Page, title: string) {
  await card(page, title).hover();
  await card(page, title).getByRole('button', { name: 'Archive note', exact: true }).click();
  await expect(card(page, title)).toHaveCount(0);
}

async function createMixedResults(page: Page, label?: string) {
  // Archived notes are deliberately created last and one is pinned: neither
  // timestamp nor pinning may promote an archived card above a live card.
  await createNote(page, 'Live older', 'shared-result live-only', label);
  await createNote(page, 'Live pinned', 'shared-result live-only', label);
  await pin(page, 'Live pinned');
  await createNote(page, 'Archived newer', 'shared-result archived-only', label);
  await archive(page, 'Archived newer');
  await createNote(page, 'Archived pinned newest', 'shared-result archived-only', label);
  await pin(page, 'Archived pinned newest');
  await archive(page, 'Archived pinned newest');
  await expect(page.getByRole('article').getByRole('heading')).toHaveText(['Live pinned', 'Live older']);
}

async function expectSeparatedResults(page: Page) {
  const region = archivedRegion(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveClass(/archived-results/);
  const heading = region.getByRole('heading', { name: 'Archived notes', level: 2, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS('justify-content', 'center');
  await expect(region.getByRole('article').getByRole('heading')).toHaveText(['Archived pinned newest', 'Archived newer']);
  await expect(page.getByRole('article').getByRole('heading')).toHaveText(['Live pinned', 'Live older', 'Archived pinned newest', 'Archived newer']);
  for (const title of ['Live pinned', 'Live older']) {
    expect(await card(page, title).evaluate(element => element.closest('.archived-results') === null)).toBe(true);
  }
  const gutter = await heading.evaluate(element => {
    const live = [...document.querySelectorAll('article.note-card')].filter(note => !note.closest('.archived-results'));
    return element.getBoundingClientRect().top - Math.max(...live.map(note => note.getBoundingClientRect().bottom));
  });
  expect(gutter).toBeGreaterThanOrEqual(40);
}

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `archive-sections-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('global search shows every live result before the separately headed archive, with pins inside each section', async ({ page }) => {
  await createMixedResults(page);
  const search = page.getByRole('searchbox', { name: 'Search notes', exact: true });
  await search.fill('shared-result');
  await expectSeparatedResults(page);

  await search.fill('archived-only');
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(archivedRegion(page).getByRole('article')).toHaveCount(2);
  await expect(archivedRegion(page).getByRole('heading', { name: 'Archived notes', exact: true })).toBeVisible();

  await search.fill('live-only');
  await expect(page.getByRole('article').getByRole('heading')).toHaveText(['Live pinned', 'Live older']);
  await expect(archivedRegion(page)).toHaveCount(0);
});

test('label results keep newer pinned archive notes below live notes and retain the section when searching within a label', async ({ page }, testInfo) => {
  const label = 'Archive Review';
  await createMixedResults(page, label);
  await createNote(page, 'Unlabeled mention', `shared-result ${label}`);
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  await page.getByRole('group', { name: 'Labels', exact: true }).getByRole('button', { name: `Show label ${label}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await expect(card(page, 'Unlabeled mention')).toHaveCount(0);
  await expectSeparatedResults(page);
  await page.screenshot({ path: testInfo.outputPath('archive-fold.png'), fullPage: true });

  await page.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('shared-result');
  await expectSeparatedResults(page);
  await expect(card(page, 'Unlabeled mention')).toHaveCount(0);
});
