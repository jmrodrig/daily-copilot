import { test, expect, type Page } from '@playwright/test';

// A stand-in for PUT/GET /api/notes/file that keeps the note's front-matter between requests, as the backend does.
async function mockNote(page: Page, frontmatter: Record<string, unknown>) {
  const note = { path: 'test.md', frontmatter: { ...frontmatter }, content: 'Hello\n' };
  const puts: unknown[] = [];
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({ json: [] }));
  await page.route((url) => url.pathname === '/api/notes/file', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      puts.push(body);
      if (body.tags) note.frontmatter = { ...note.frontmatter, tags: body.tags };
      if (body.content !== undefined) note.content = body.content;
    }
    await route.fulfill({ json: note });
  });
  return puts;
}

for (const state of ['draft', 'published']) {
  test(`adding a tag to a ${state} note shows it at once`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const puts = await mockNote(page, { state, tags: ['C7801'] });

    await page.goto('http://localhost:5173/note?space=1&path=test.md');
    const tags = page.getByRole('group', { name: 'Tags' });
    await expect(tags).toContainText('#C7801');

    await tags.getByRole('button', { name: '+ Add tag' }).click();
    await page.getByLabel('New tag').fill('urgent');
    await page.getByLabel('New tag').press('Enter');

    await expect(tags).toContainText('#urgent');
    await expect(tags).toContainText('#C7801');
    expect(puts).toContainEqual({ space_id: 1, path: 'test.md', tags: ['C7801', 'urgent'] });
    expect(errors).toEqual([]);
  });
}
