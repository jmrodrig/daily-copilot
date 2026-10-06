import { test, expect } from '@playwright/test';

test('an attachment shows a progress pill while uploading, then can be removed from the bubble menu', async ({ page }) => {
  await page.route('**/api/notes/file*', (route) =>
    route.fulfill({ json: { path: 'test.md', frontmatter: { state: 'draft' }, content: 'Before ' } }),
  );
  await page.route('**/api/tasks*', (route) => route.fulfill({ json: [] }));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/notes/image', async (route) => {
    await released;
    await route.fulfill({ json: { url: '/api/notes/image/1/report.pdf' } });
  });

  await page.goto('http://localhost:5173/note?space=1&path=test.md');
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');

  await page.locator('input[type="file"]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048) });

  // Uploading: a placeholder pill with a progress bar.
  const placeholder = page.locator('.upload-pill');
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toContainText('report.pdf');
  await expect(placeholder.locator('.upload-pill-bar')).toHaveCount(1);

  release();

  // Uploaded: the placeholder gives way to the attachment pill, which asks for the pointer.
  const pill = editor.locator('a[href="/api/notes/image/1/report.pdf"]');
  await expect(pill).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  expect(await pill.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  expect(await pill.evaluate((el) => getComputedStyle(el, '::before').cursor)).toBe('pointer');

  // Remove it from the bubble menu.
  await pill.click();
  const remove = page.getByRole('button', { name: 'Remove attachment' });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(pill).toHaveCount(0);
  await expect(editor).toHaveText('Before');
});
