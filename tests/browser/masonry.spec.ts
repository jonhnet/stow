import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const orderedTitles = (page: Page) => page.locator('.windowed-card .note-card h2').allTextContents();
const unevenLines = [1, 1, 12, 1, 1, 1, 1];

async function frames(page: Page, count = 5) {
  await page.evaluate(count => new Promise<void>(resolve => {
    const next = () => { if (--count <= 0) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}

async function seed(page: Page, context: BrowserContext, lines = unevenLines,
  prepare?: (vault: Vault, ids: string[], vaultId: string) => Promise<void>) {
  const session = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  const fixture = new Vault();
  const ids = lines.map((count, index) => fixture.createNote('text', {
    title: `Masonry ${String(index).padStart(3, '0')}`,
    body: Array.from({ length: count }, (_, line) => `Short line ${line + 1}`).join('\n'),
  }));
  fixture.doc.transact(() => ids.forEach((id, index) => {
    fixture.notes.get(id)!.set('placement', { pinned: false, sortOrderDate: 1_700_000_000_000 - index * 1000 });
  }));
  if (prepare) await prepare(fixture, ids, session.vaultId);
  const notes = fixture.getNotes().map(note => ({ id: note.id, title: note.title }));
  const update = [...Y.encodeStateAsUpdate(fixture.doc)];
  fixture.doc.destroy();
  await page.goto(`${ORIGIN}/api/health`);
  await page.evaluate(async ({ update, vaultId }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`stow-notes-${vaultId}`, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('updates', { autoIncrement: true }); request.result.createObjectStore('pendingEdits'); request.result.createObjectStore('maintenance'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('updates', 'readwrite');
        transaction.objectStore('updates').add(new Uint8Array(update));
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { update, vaultId: session.vaultId });
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(card(page, notes[0].title)).toBeVisible();
  await frames(page);
  return notes;
}

async function rectangles(page: Page) {
  return page.locator('.windowed-card').evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect();
    return { id: (element as HTMLElement).dataset.noteId!, title: element.querySelector('h2')!.textContent!,
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, bottom: bounds.bottom };
  }));
}

async function placementErrors(page: Page) {
  const bounds = await rectangles(page);
  const columns = [...new Set(bounds.map(rect => rect.x))].sort((a, b) => a - b);
  const gap = columns[1] - columns[0] - bounds[0].width;
  const bottoms = columns.map(() => Math.min(...bounds.map(rect => rect.y)));
  const errors: string[] = [];
  for (const rect of bounds) {
    const top = Math.min(...bottoms);
    const column = bottoms.findIndex(bottom => Math.abs(bottom - top) < .5);
    if (Math.abs(rect.x - columns[column]) > 1 || Math.abs(rect.y - top) > 1) errors.push(rect.title);
    bottoms[column] = top + rect.height + gap;
  }
  return errors;
}

test.beforeEach(async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 620, height: 1000 });
  await context.addCookies([{ name: 'stow_test_user', value: `masonry-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
});

test('uneven cards fill the shortest column, break ties to the left, and preserve stored note order', async ({ page, context }) => {
  const notes = await seed(page, context);
  const titles = notes.map(note => note.title);
  await expect.poll(async () => {
    const cards = await rectangles(page);
    return cards.length === notes.length && Math.abs(cards[4].x - cards[3].x) < 1;
  }).toBe(true);
  const bounds = await rectangles(page);
  expect(bounds[0].x).toBeLessThan(bounds[1].x);
  expect(Math.abs(bounds[0].y - bounds[1].y)).toBeLessThan(1);
  expect(Math.abs(bounds[0].height - bounds[1].height)).toBeLessThan(1);
  // The first equal pair leaves a tie: the next card must start on the left.
  expect(Math.abs(bounds[2].x - bounds[0].x)).toBeLessThan(1);
  expect(Math.abs(bounds[2].y - bounds[3].y)).toBeLessThan(1);
  expect(bounds[2].height).toBeGreaterThan(bounds[3].height + 100);
  // A tall left card makes the next short card continue down the right.
  expect(Math.abs(bounds[4].x - bounds[3].x)).toBeLessThan(1);
  expect(bounds[4].y).toBeGreaterThan(bounds[3].bottom);
  expect(bounds[4].y).toBeLessThan(bounds[2].bottom);
  expect(await orderedTitles(page)).toEqual(titles);
  await card(page, titles[2]).getByRole('button', { name: 'Select note', exact: true }).click();
  await expect(card(page, titles[2])).toHaveClass(/selected/);
  await frames(page);
  expect(await rectangles(page)).toEqual(bounds);
  await card(page, titles[2]).getByRole('button', { name: 'Deselect note', exact: true }).click();
  await expect(card(page, titles[2])).not.toHaveClass(/selected/);
  await frames(page);
  expect(await rectangles(page)).toEqual(bounds);
  await page.screenshot({ path: test.info().outputPath('shortest-column-notes.png') });
  await page.reload();
  await expect.poll(() => orderedTitles(page)).toEqual(titles);
});

test('a long collection stays windowed and keeps a visible note anchored when an earlier mounted card grows', async ({ page, context }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  const notes = await seed(page, context, Array.from({ length: 260 }, (_, index) => index % 5 === 0 ? 5 : 1));
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await frames(page);
  expect(await page.locator('.note-card').count()).toBeLessThan(50);
  await page.evaluate(() => window.scrollTo(0, 2500));
  await frames(page, 8);
  expect(await page.locator('.note-card').count()).toBeLessThan(50);
  await expect(card(page, notes[0].title)).toHaveCount(0);
  const mounted = await rectangles(page);
  const anchor = mounted.find(rect => rect.y >= 100 && rect.y < 350)!;
  expect(anchor, 'a fully visible note below the fixed toolbar').toBeTruthy();
  const earlier = mounted.filter(rect => rect.bottom < 90).at(-1)!;
  expect(earlier, 'an overscanned card remains mounted above the viewport').toBeTruthy();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await card(page, earlier.title).evaluate((element, height) => {
    (element as HTMLElement).style.minHeight = `${height}px`;
  }, earlier.height + 180);
  await expect.poll(async () => (await card(page, earlier.title).boundingBox())!.height).toBeGreaterThan(earlier.height + 175);
  await frames(page, 8);
  const after = (await card(page, anchor.title).boundingBox())!;
  expect(Math.abs(after.y - anchor.y)).toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore + 175);
  await expect.poll(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    return card(page, notes.at(-1)!.title).count();
  }).toBe(1);
  expect(await page.locator('.note-card').count()).toBeLessThan(50);
});

test('late portrait and landscape thumbnails keep their reserved gallery size', async ({ page, context }) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const requested = new Set<string>();
  await page.route('**/api/blobs/*/thumbnail', async route => {
    requested.add(new URL(route.request().url()).pathname);
    await ready;
    await route.continue();
  });
  try {
    const notes = await seed(page, context, [1, 1, 1, 1, 1], async (fixture, ids, vaultId) => {
      for (const [index, dimensions] of [{ width: 30, height: 240 }, { width: 280, height: 40 }].entries()) {
        const bytes = await sharp({ create: { ...dimensions, channels: 4, background: index ? '#0099aa' : '#cc7744' } }).png().toBuffer();
        const hash = createHash('sha256').update(bytes).digest('hex');
        const response = await context.request.put(`${ORIGIN}/api/blobs/${hash}`, {
          data: bytes, headers: { 'X-Stow-Vault': vaultId, 'Content-Type': 'application/octet-stream' },
        });
        expect(response.status()).toBe(204);
        fixture.addAttachment({ id: `masonry-image-${index}`, noteId: ids[0], hash, name: `orientation-${index}.png`, type: 'image/png', size: bytes.length });
      }
    });
    await expect.poll(() => requested.size).toBe(2);
    const gallery = card(page, notes[0].title).locator('.card-images');
    await expect(gallery.locator('.image-placeholder')).toHaveCount(2);
    const before = (await gallery.boundingBox())!;
    const cardBefore = (await card(page, notes[0].title).boundingBox())!;
    release();
    await expect(gallery.locator('img')).toHaveCount(2);
    await expect.poll(() => gallery.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await frames(page);
    const after = (await gallery.boundingBox())!;
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    expect(Math.abs((await card(page, notes[0].title).boundingBox())!.height - cardBefore.height)).toBeLessThan(1);
  } finally { release(); }
});

test('plain arrow keys follow neighboring cards in uneven columns without reordering notes', async ({ page, context }) => {
  const notes = await seed(page, context);
  await expect.poll(async () => {
    const bounds = await rectangles(page);
    return Math.abs(bounds[4].x - bounds[3].x) < 1;
  }).toBe(true);
  await card(page, notes[3].title).focus();
  await page.keyboard.press('ArrowDown');
  await expect(card(page, notes[4].title)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(card(page, notes[3].title)).toBeFocused();
  await card(page, notes[4].title).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(card(page, notes[2].title)).toBeFocused();
  expect(await orderedTitles(page)).toEqual(notes.map(note => note.title));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a drag keeps its insertion target while card measurements change, then applies the new layout after drop', async ({ page, context }) => {
  const notes = await seed(page, context);
  await expect.poll(async () => {
    const bounds = await rectangles(page);
    return Math.abs(bounds[4].x - bounds[3].x) < 1;
  }).toBe(true);
  const source = (await card(page, notes[0].title).boundingBox())!;
  const target = (await card(page, notes[4].title).boundingBox())!;
  const earlier = (await card(page, notes[3].title).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + 40);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + 40);
  await expect(page.locator('.note-drag-ghost')).toBeVisible();
  await page.mouse.move(target.x + target.width * .75, target.y + 40, { steps: 8 });
  const marker = page.locator('.note-drop-marker');
  await expect(marker).toHaveAttribute('data-drop-note', notes[4].id);
  await expect(marker).toHaveAttribute('data-drop-position', 'after');
  const markerBefore = (await marker.boundingBox())!;
  await card(page, notes[3].title).evaluate((element, height) => {
    (element as HTMLElement).style.minHeight = `${height}px`;
  }, earlier.height + 180);
  await frames(page, 8);
  expect((await card(page, notes[3].title).boundingBox())!.height).toBeGreaterThan(earlier.height + 175);
  await expect(marker).toHaveAttribute('data-drop-note', notes[4].id);
  const markerAfter = (await marker.boundingBox())!;
  expect(Math.abs(markerAfter.x - markerBefore.x)).toBeLessThan(1);
  expect(Math.abs(markerAfter.y - markerBefore.y)).toBeLessThan(1);
  expect(Math.abs((await card(page, notes[4].title).boundingBox())!.y - target.y)).toBeLessThan(1);
  await page.mouse.up();
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  const moved = [...notes.slice(1, 5), notes[0], ...notes.slice(5)].map(note => note.title);
  await expect.poll(() => orderedTitles(page)).toEqual(moved);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => placementErrors(page)).toEqual([]);
  expect(Math.abs((await card(page, notes[4].title).boundingBox())!.y - target.y)).toBeGreaterThan(20);
});

test('resizing during a pending mouse press cancels the gesture before later movement can start a stale drag', async ({ page, context }) => {
  const notes = await seed(page, context);
  const before = (await card(page, notes[0].title).boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + 40);
  await page.mouse.down();
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await page.setViewportSize({ width: 580, height: 1000 });
  await expect.poll(async () => (await card(page, notes[0].title).boundingBox())!.width).toBeLessThan(before.width - 10);
  await frames(page);
  await page.mouse.move(before.x + before.width / 2 + 35, before.y + 40, { steps: 5 });
  await frames(page);
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await expect(page.locator('.note-drop-marker')).toHaveCount(0);
  await page.mouse.up();
  expect(await orderedTitles(page)).toEqual(notes.map(note => note.title));
});

test('a growing pinned card cannot shift an unpinned drag target until the gesture ends', async ({ page, context }) => {
  const notes = await seed(page, context, [1, 1, 1, 1, 1, 1], async (fixture, ids) => {
    fixture.setNoteMeta(ids[0], { pinned: true });
  });
  const pinned = notes.find(note => note.title === 'Masonry 000')!;
  const unpinned = notes.filter(note => note.id !== pinned.id);
  await expect(page.locator('.windowed-notes')).toHaveCount(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const source = (await card(page, unpinned[0].title).boundingBox())!;
  const target = (await card(page, unpinned[1].title).boundingBox())!;
  const pinnedBefore = (await card(page, pinned.title).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + 40);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + 40);
  await expect(page.locator('.note-drag-ghost')).toBeVisible();
  await page.mouse.move(target.x + target.width * .75, target.y + 40, { steps: 8 });
  const marker = page.locator('.note-drop-marker');
  await expect(marker).toHaveAttribute('data-drop-note', unpinned[1].id);
  const markerBefore = (await marker.boundingBox())!;
  await card(page, pinned.title).evaluate((element, height) => {
    (element as HTMLElement).style.minHeight = `${height}px`;
  }, pinnedBefore.height + 180);
  await frames(page, 8);
  expect((await card(page, pinned.title).boundingBox())!.height).toBeGreaterThan(pinnedBefore.height + 175);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(marker).toHaveAttribute('data-drop-note', unpinned[1].id);
  const markerAfter = (await marker.boundingBox())!;
  expect(Math.abs(markerAfter.x - markerBefore.x)).toBeLessThan(1);
  expect(Math.abs(markerAfter.y - markerBefore.y)).toBeLessThan(1);
  expect(Math.abs((await card(page, unpinned[1].title).boundingBox())!.y - target.y)).toBeLessThan(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await expect(marker).toHaveCount(0);
  await expect.poll(async () => (await card(page, unpinned[1].title).boundingBox())!.y).toBeGreaterThan(target.y + 175);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await orderedTitles(page)).toEqual([pinned, ...unpinned].map(note => note.title));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
