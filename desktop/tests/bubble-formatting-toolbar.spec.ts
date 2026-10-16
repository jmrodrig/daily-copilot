import { test, expect, type Page } from '@playwright/test';

/** Mock one note (and what the editor's menus load); returns the bodies of its saves. */
async function setup(page: Page, content: string) {
  const saved: string[] = [];
  await page.route('**/api/notes/file*', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      saved.push(body.content);
      return route.fulfill({ json: { path: 'C7801/test.md', frontmatter: { state: 'draft' }, content: body.content } });
    }
    return route.fulfill({ json: { path: 'C7801/test.md', frontmatter: { state: 'draft' }, content } });
  });
  await page.route('**/api/tasks*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes/recent*', (route) => route.fulfill({ json: [] }));
  await page.goto('http://localhost:5173/note?space=1&path=C7801/test.md');
  return { saved };
}

/** Select characters `from`..`to` of the editor's first paragraph. */
async function select(page: Page, from: number, to: number) {
  const editor = page.locator('.note-body');
  await editor.click();
  await editor.evaluate((_el, [start, end]) => {
    const text = document.querySelector('.note-body p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, [from, to]);
}

test('selected text gets a formatting bar: heading, bold, color and lists, keeping the selection', async ({ page }) => {
  const { saved } = await setup(page, 'Hull lines review');
  await select(page, 0, 4); // "Hull"

  const bar = page.getByRole('toolbar', { name: 'Format selection' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Heading 2' })).toBeVisible();

  await bar.getByRole('button', { name: /Bold/ }).click();
  await expect(page.locator('.note-body strong')).toHaveText('Hull');
  await expect(bar.getByRole('button', { name: /Bold/ })).toHaveAttribute('aria-pressed', 'true');

  // Still selected: the next button formats the same text.
  await bar.getByRole('button', { name: /Italic/ }).click();
  await expect(page.locator('.note-body em')).toHaveText('Hull');

  await bar.getByRole('button', { name: 'Text color' }).click();
  await bar.getByRole('button', { name: 'Blue' }).click();
  await expect(page.locator('.note-body span[style*="color"]')).toHaveText('Hull');

  await bar.getByRole('button', { name: 'Heading 2' }).click();
  await expect(page.locator('.note-body h2')).toContainText('Hull lines review');

  await bar.getByRole('button', { name: 'Bullet list' }).click();
  await expect(page.locator('.note-body ul li')).toContainText('Hull lines review');

  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toMatch(/^- .*Hull/m);
});

test('the formatting bar still offers Task and Link', async ({ page }) => {
  await setup(page, 'Order the steel');
  await select(page, 0, 5);
  await expect(page.getByRole('button', { name: 'Task', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Insert link' })).toBeVisible();
});
