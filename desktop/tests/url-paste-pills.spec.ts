import { test, expect, type Locator, type Page } from '@playwright/test';

/** Dispatch a paste of `text` (as plain text) on `target`. */
async function paste(target: Locator, text: string) {
  await target.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function setupNote(page: Page, content: string) {
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
  // Pages without a title: a pasted URL stays the pill's label.
  await page.route('**/api/url-metadata*', (route) => route.fulfill({ json: { title: null } }));
  await page.goto('http://localhost:5173/note?space=1&path=C7801/test.md');
  return { saved };
}

test('a URL pasted at the caret goes in as a link pill', async ({ page }) => {
  const { saved } = await setupNote(page, 'See ');
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');
  await paste(editor, 'https://github.com');

  await expect(editor.locator('.reference-pill.url')).toHaveText('https://github.com');
  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toContain('[https://github.com](https://github.com "ref:url")');
});

test('a URL pasted over selected text links that text as a pill', async ({ page }) => {
  const { saved } = await setupNote(page, 'Search on Google today');
  const editor = page.locator('.note-body');
  await editor.click();
  await editor.evaluate(() => {
    const text = document.querySelector('.note-body p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 10);
    range.setEnd(text, 16); // "Google"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await paste(editor, 'https://google.com');

  await expect(editor.locator('.reference-pill.url')).toHaveText('Google');
  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toContain('[Google](https://google.com "ref:url")');
});

test('bare URLs in pasted text become pills', async ({ page }) => {
  await setupNote(page, '');
  const editor = page.locator('.note-body');
  await editor.click();
  await paste(editor, 'Specs at https://example.com/specs, and more\nsecond line');

  await expect(editor.locator('.reference-pill.url')).toHaveText('https://example.com/specs');
  await expect(editor).toContainText(', and more');
});

const TASK = {
  id: 7, space_id: 1, project_id: 1, project_code: 'C7801', title: 'Order the steel', description: '', status: 'todo',
  priority: 'normal', assignee: null, start_date: null, deadline: null, completion_percent: 0, is_gantt_task: false,
  is_milestone: false, tags: [], note_path: null, comments: [] as Record<string, unknown>[], custom_fields: {},
};

test('a URL pasted into a comment goes in as a pill and shows as one', async ({ page }) => {
  const task = { ...TASK, comments: [...TASK.comments] };
  const comments: Record<string, unknown>[] = [];
  await page.route('**/api/tasks?*', (route) => route.fulfill({ json: [task] }));
  await page.route('**/api/tasks/7', (route) => route.fulfill({ json: task }));
  await page.route('**/api/tasks/7/comments', async (route) => {
    const body = route.request().postDataJSON();
    comments.push(body);
    task.comments.push({ id: 'c1', author: body.author, text: body.text, created_at: '2026-10-06T09:30:00', updated_at: null });
    return route.fulfill({ status: 201, json: task });
  });
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [{ id: 1, code: 'C7801', name: 'Bridge', folder_path: 'C7801' }] }));
  await page.route('**/api/spaces/1/tags', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/spaces', (route) => route.fulfill({ json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [] }] }));
  await page.route('**/api/people?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/url-metadata*', (route) => route.fulfill({ json: { title: null } }));
  await page.goto('http://localhost:5173/tasks/kanban?taskId=7');

  const panel = page.getByRole('region', { name: 'Task details' });
  const box = panel.getByLabel('New comment');
  await box.fill('Quote: ');
  await box.press('End');
  await paste(box, 'https://supplier.example/quote');
  await expect(box).toHaveValue('Quote: [https://supplier.example/quote](https://supplier.example/quote "ref:url")');

  await panel.getByRole('button', { name: 'Comment' }).click();
  await expect.poll(() => comments.length).toBe(1);
  const pill = panel.locator('li .reference-pill.url');
  await expect(pill).toHaveText('https://supplier.example/quote');
  await expect(pill).toHaveAttribute('href', 'https://supplier.example/quote');
});
