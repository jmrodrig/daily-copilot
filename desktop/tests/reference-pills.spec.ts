import { test, expect, type Page } from '@playwright/test';

const TASKS = [
  { id: 3, space_id: 1, project_id: 1, project_code: 'C7801', title: 'Order the steel', description: '', status: 'todo', priority: 'normal', assignee: null, start_date: null, deadline: null, completion_percent: 0, is_gantt_task: false, is_milestone: false, tags: ['welding'], note_path: null },
];
const NOTES = [
  { path: 'C7801/review.md', title: 'Design review', tags: ['client'], modified: '2026-10-05T10:00:00' },
  { path: 'Inbox/ideas.md', title: 'Ideas', tags: [], modified: '2026-10-01T10:00:00' },
];

/** Mock the note and the APIs the panels use; returns the bodies of saves and created tasks. */
async function setup(page: Page, content: string, state = 'draft') {
  const saved: string[] = [];
  const created: Record<string, unknown>[] = [];
  await page.route('**/api/notes/file*', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      saved.push(body.content);
      return route.fulfill({ json: { path: 'C7801/test.md', frontmatter: { state: 'draft' }, content: body.content } });
    }
    return route.fulfill({ json: { path: 'C7801/test.md', frontmatter: { state }, content } });
  });
  await page.route('**/api/tasks*', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      created.push(body);
      return route.fulfill({ status: 201, json: { ...TASKS[0], ...body, id: 42, project_code: null } });
    }
    return route.fulfill({ json: TASKS });
  });
  await page.route('**/api/projects*', (route) =>
    route.fulfill({ json: [{ id: 1, code: 'C7801', name: 'Bridge', folder_path: 'C7801' }] }),
  );
  await page.route('**/api/notes/recent*', (route) => route.fulfill({ json: NOTES }));
  await page.goto('http://localhost:5173/note?space=1&path=C7801/test.md');
  return { saved, created };
}

test('typing / offers Task and Link; a task created from it goes in as a pill', async ({ page }) => {
  const { saved, created } = await setup(page, 'Start ');
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('/');

  const menu = page.getByRole('listbox', { name: 'Insert' });
  await expect(menu.getByRole('option')).toHaveText([/Task/, /Link/, /Whiteboard/]);
  await page.keyboard.type('ta');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');

  const panel = page.getByRole('form', { name: 'Create task' });
  await expect(panel).toBeVisible();
  await expect(editor).toHaveText('Start'); // the `/ta` is gone
  await panel.getByLabel('Title').fill('Weld the frame');
  await expect(panel.getByLabel('Project')).toContainText('Bridge'); // the note's project folder
  await panel.getByLabel('Assignee').fill('Sam');
  await panel.getByLabel('Due in').selectOption('7');
  await panel.getByRole('switch', { name: /In progress/ }).click();
  await panel.getByRole('button', { name: 'Create task' }).click();

  await expect(panel).toHaveCount(0);
  expect(created[0]).toMatchObject({ title: 'Weld the frame', project_id: 1, assignee: 'Sam', status: 'in_progress' });
  expect(created[0].deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(created[0]).not.toHaveProperty('note_path');
  const pill = editor.locator('.reference-pill.task');
  await expect(pill).toHaveText('Weld the frame');

  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toContain('[Weld the frame](/tasks/backlog?taskId=42 "ref:task")');
});

test('selected text becomes a link pill to a note, under the note\'s own title', async ({ page }) => {
  const { saved } = await setup(page, 'See the review notes here');
  const editor = page.locator('.note-body');
  await editor.click();
  await editor.evaluate(() => {
    const p = document.querySelector('.note-body p')!;
    const text = p.firstChild!;
    const range = document.createRange();
    range.setStart(text, 8);
    range.setEnd(text, 20); // "review notes"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.getByRole('button', { name: 'Link' }).click();

  const panel = page.getByRole('form', { name: 'Insert link' });
  await expect(panel.getByRole('option')).toHaveCount(3); // 2 recent notes + 1 task
  await panel.getByRole('combobox').fill('#client');
  await expect(panel.getByRole('option')).toHaveText([/Design review/]);
  await panel.getByRole('option').first().click();
  await expect(panel.getByLabel('Display text')).toHaveValue('Design review');
  await expect(panel.getByLabel('Display text')).toHaveAttribute('readonly', '');
  await panel.getByRole('button', { name: 'Insert' }).click();

  await expect(editor.locator('.reference-pill.note')).toHaveText('Design review');
  await expect(editor).toHaveText('See the Design review here');
  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toBe(
    'See the [Design review](/note?space=1&path=C7801%2Freview.md "ref:note") here',
  );
});

test('a pasted URL goes in as a link pill with the display text typed', async ({ page }) => {
  const { saved } = await setup(page, 'Supplier: ');
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('/link');
  await page.keyboard.press('Enter');

  const panel = page.getByRole('form', { name: 'Insert link' });
  await panel.getByRole('combobox').fill('https://example.com/steel (spec)');
  await expect(panel.getByRole('option')).toHaveCount(0);
  await panel.getByRole('combobox').fill('https://example.com/steel');
  await panel.getByLabel('Display text').fill('Steel [catalogue]');
  await panel.getByRole('button', { name: 'Insert' }).click();

  await expect(editor.locator('.reference-pill.url')).toHaveText('Steel [catalogue]');
  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toContain('[Steel \\[catalogue\\]](https://example.com/steel "ref:url")');
});

test('saved pills read back as pills, and an ordinary link stays a link', async ({ page }) => {
  await setup(page, 'A [Task one](/tasks/backlog?task=3 "ref:task"), [Ideas](/note?space=1&path=Inbox%2Fideas.md "ref:note") and [plain](https://example.com).');
  const editor = page.locator('.note-body');
  await expect(editor.locator('.reference-pill.task')).toHaveText('Task one');
  await expect(editor.locator('.reference-pill.note')).toHaveText('Ideas');
  await expect(editor.locator('.reference-pill')).toHaveCount(2);
  await expect(editor.locator('a[href="https://example.com"]')).toHaveText('plain');
});

test('a published note shows pills too, opening a note in the app', async ({ page }) => {
  await setup(page, 'See [Ideas](/note?space=1&path=Inbox%2Fideas.md "ref:note") and [site](https://example.com "ref:url").', 'published');
  const article = page.locator('article.note-body');
  const note = article.locator('a.reference-pill.note');
  await expect(note).toHaveText('Ideas');
  await expect(note).not.toHaveAttribute('target', '_blank');
  await expect(article.locator('a.reference-pill.url')).toHaveAttribute('target', '_blank');
  await note.click();
  await expect(page).toHaveURL(/path=Inbox%2Fideas\.md/);
});

test('a task pill in a published note opens the task panel beside the note, even one saved before the panel', async ({ page }) => {
  await page.route('**/api/tasks/3', (route) => route.fulfill({ json: { ...TASKS[0], description: 'Grade S355', comments: [] } }));
  await setup(page, 'See [Task one](/tasks/backlog?task=3 "ref:task").', 'published');
  await page.locator('article.note-body a.reference-pill.task').click();
  await expect(page).toHaveURL(/\/note\?.*taskId=3/);
  const panel = page.getByRole('region', { name: 'Task details' });
  await expect(panel.getByLabel('Title')).toHaveValue('Order the steel');
  await expect(panel.getByText('Grade S355')).toBeVisible();
  await panel.getByRole('button', { name: 'Close task' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/taskId=/);
});

test('inferred pills without ref title render as pills in published notes and resolve relative paths', async ({ page }) => {
  await setup(
    page,
    'See [Rig loads](C7801/Rig%20loads.md), [Task three](/tasks/backlog?taskId=3), and [External](https://example.com).',
    'published'
  );
  const article = page.locator('article.note-body');
  const notePill = article.locator('a.reference-pill.note');
  await expect(notePill).toHaveText('Rig loads');
  await expect(notePill).not.toHaveAttribute('target', '_blank');

  const taskPill = article.locator('a.reference-pill.task');
  await expect(taskPill).toHaveText('Task three');

  // External link without ref: title is a plain link, not a reference-pill
  const plainLink = article.locator('a[href="https://example.com"]');
  await expect(plainLink).toHaveText('External');
  await expect(plainLink).not.toHaveClass(/reference-pill/);

  // Clicking relative note pill navigates with spaceId and encoded path
  await notePill.click();
  await expect(page).toHaveURL(/note\?space=1&path=C7801(%2F|\/)Rig(%20|\+)loads\.md/);
});

test('inferred pills without ref title are parsed as reference pills in editor', async ({ page }) => {
  await setup(
    page,
    'Check [Rig loads](C7801/review.md) and [Task 3](/tasks/backlog?taskId=3) and [Plain](https://example.com).'
  );
  const editor = page.locator('.note-body');
  await expect(editor.locator('.reference-pill.note')).toHaveText('Rig loads');
  await expect(editor.locator('.reference-pill.task')).toHaveText('Task 3');
  await expect(editor.locator('.reference-pill')).toHaveCount(2);
  await expect(editor.locator('a[href="https://example.com"]')).toHaveText('Plain');
});

