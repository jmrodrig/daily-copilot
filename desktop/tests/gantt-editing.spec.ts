import { test, expect, type Page } from '@playwright/test';

const TASK = {
  space_id: 1, project_id: 1, project_code: 'C7801', project_color: '#56c8a8', description: '', status: 'todo', priority: 'normal',
  assignee: null, completion_percent: 25, is_gantt_task: true, is_milestone: false, tags: [], note_path: null, comments: [],
  custom_fields: {},
};
// Today is mocked to 2026-10-08 so the timeline is the same on every run.
const TASKS = [
  { ...TASK, id: 1, title: 'Weld keel', start_date: '2026-10-01', deadline: '2026-10-10' },
  { ...TASK, id: 2, title: 'Paint deck', start_date: '2026-10-12', deadline: '2026-10-20' },
  { ...TASK, id: 3, title: 'Fit engine', start_date: '2026-10-21', deadline: '2026-10-30' },
];
const DAY_PX = 20;

// Wide enough that no bar starts in the edge zones where dragging scrolls the timeline.
test.use({ viewport: { width: 1600, height: 900 } });

/** Mock the task APIs on the Gantt view; returns the bulk-update bodies sent. */
async function setup(page: Page) {
  const bulk: { task_ids: number[]; updates: Record<string, unknown> }[] = [];
  await page.clock.setFixedTime(new Date('2026-10-08T10:00:00'));
  await page.route('**/api/tasks?*', (route) => route.fulfill({ json: TASKS }));
  await page.route('**/api/tasks/bulk-update', (route) => {
    const body = route.request().postDataJSON();
    bulk.push(body);
    return route.fulfill({ json: TASKS.filter((t) => body.task_ids.includes(t.id)).map((t) => ({ ...t, ...body.updates })) });
  });
  await page.route('**/api/projects*', (route) =>
    route.fulfill({ json: [{ id: 1, code: 'C7801', name: 'Bridge', color: '#56c8a8', folder_path: 'C7801' }] }),
  );
  await page.route('**/api/spaces/1/tags', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/spaces', (route) =>
    route.fulfill({ json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [] }] }),
  );
  await page.route('**/api/people?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes?*', (route) => route.fulfill({ json: [] }));
  await page.goto('http://localhost:5173/tasks/gantt');
  return { bulk };
}

const bar = (page: Page, name: string) => page.locator(`[title^="${name} ·"] > div`).first();

async function dragBy(page: Page, x: number, y: number, dx: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('dragging a bar moves both dates, and Undo puts them back', async ({ page }) => {
  const { bulk } = await setup(page);
  const box = (await bar(page, 'Weld keel').boundingBox())!;
  await dragBy(page, box.x + box.width / 2, box.y + box.height / 2, 3 * DAY_PX);
  await expect.poll(() => bulk.at(-1)).toEqual({ task_ids: [1], updates: { start_date: '2026-10-04', deadline: '2026-10-13' } });
  // The click that ends a drag doesn't open the task.
  await expect(page).not.toHaveURL(/taskId=/);
  const toast = page.getByRole('status').filter({ hasText: 'Moved "Weld keel" · +3 days' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => bulk.at(-1)).toEqual({ task_ids: [1], updates: { start_date: '2026-10-01', deadline: '2026-10-10' } });
});

test('dragging the edges changes only the start or the due date', async ({ page }) => {
  const { bulk } = await setup(page);
  let box = (await bar(page, 'Paint deck').boundingBox())!;
  await dragBy(page, box.x + box.width - 2, box.y + box.height / 2, 2 * DAY_PX);
  await expect.poll(() => bulk.at(-1)).toEqual({ task_ids: [2], updates: { start_date: '2026-10-12', deadline: '2026-10-22' } });
  box = (await bar(page, 'Paint deck').boundingBox())!;
  await dragBy(page, box.x + 2, box.y + box.height / 2, -DAY_PX);
  await expect.poll(() => bulk.at(-1)).toEqual({ task_ids: [2], updates: { start_date: '2026-10-11', deadline: '2026-10-22' } });
});

test('Ctrl-click and Shift-click select tasks, which then drag together', async ({ page }) => {
  const { bulk } = await setup(page);
  await bar(page, 'Weld keel').click({ modifiers: ['ControlOrMeta'] });
  await bar(page, 'Fit engine').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('toolbar', { name: 'Gantt selection' })).toContainText('3 tasks selected');
  await page.getByLabel('Select Paint deck').click();
  await expect(page.getByRole('toolbar', { name: 'Gantt selection' })).toContainText('2 tasks selected');
  await expect(page.getByLabel('Select all tasks')).not.toBeChecked();

  const box = (await bar(page, 'Fit engine').boundingBox())!;
  await dragBy(page, box.x + box.width / 2, box.y + box.height / 2, -2 * DAY_PX);
  await expect.poll(() => bulk.length).toBe(2);
  expect(bulk).toEqual(
    expect.arrayContaining([
      { task_ids: [1], updates: { start_date: '2026-09-29', deadline: '2026-10-08' } },
      { task_ids: [3], updates: { start_date: '2026-10-19', deadline: '2026-10-28' } },
    ]),
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Gantt selection' })).not.toContainText('selected');
});

test("the hover cursor's shift button shifts future dates from that day", async ({ page }) => {
  const { bulk } = await setup(page);
  // Hover 15 Oct, in Paint deck's row: Weld keel ended before, Paint deck is under way, Fit engine is later.
  const paint = (await bar(page, 'Paint deck').boundingBox())!;
  // There is no fixed cursor: clicking the grid doesn't lock one or add a toolbar shift button.
  await page.mouse.click(paint.x + 3 * DAY_PX + DAY_PX / 2, paint.y - 40);
  await expect(page.getByRole('button', { name: /^Shift from/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/gantt-cursor.png' });
  await page.getByRole('button', { name: 'Shift the timeline from 15 Oct' }).click();

  const dialog = page.getByRole('dialog', { name: 'Shift the timeline' });
  await expect(dialog).toContainText('Thu 15 Oct');
  await dialog.getByLabel('Number of days').fill('5');
  await expect(dialog).toContainText('2 tasks move (1 only its due date)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/gantt-shift-dialog.png' });
  await dialog.getByRole('button', { name: 'Shift 2 tasks' }).click();
  await expect.poll(() => bulk.length).toBe(2);
  expect(bulk).toEqual(
    expect.arrayContaining([
      { task_ids: [2], updates: { deadline: '2026-10-25' } },
      { task_ids: [3], updates: { start_date: '2026-10-26', deadline: '2026-11-04' } },
    ]),
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/gantt-after-shift.png' });
});

test('shifting to today without "only future dates" moves every task', async ({ page }) => {
  const { bulk } = await setup(page);
  const keel = (await bar(page, 'Weld keel').boundingBox())!;
  // 1 Oct, Weld keel's start.
  await page.mouse.move(keel.x + DAY_PX / 2, keel.y - 40);
  await page.getByRole('button', { name: 'Shift the timeline from 1 Oct' }).click();
  const dialog = page.getByRole('dialog', { name: 'Shift the timeline' });
  await dialog.getByRole('button', { name: 'Shift to today' }).click();
  await dialog.getByLabel('Shift only future dates').uncheck();
  await expect(dialog).toContainText('+7 days · 3 tasks move');
  await dialog.getByRole('button', { name: 'Shift 3 tasks' }).click();
  await expect.poll(() => bulk.length).toBe(3);
  expect(bulk).toContainEqual({ task_ids: [1], updates: { start_date: '2026-10-08', deadline: '2026-10-17' } });
});

test('the task column can be resized by dragging its edge, within limits', async ({ page }) => {
  await setup(page);
  const header = page.getByText('Task', { exact: true }).locator('..');
  const handle = page.getByRole('separator', { name: 'Resize the task column' });
  await expect(header).toHaveCSS('width', '240px');
  const before = (await bar(page, 'Weld keel').boundingBox())!;

  let box = (await handle.boundingBox())!;
  await dragBy(page, box.x + box.width / 2, box.y + 20, 100);
  await expect(header).toHaveCSS('width', '340px');
  await expect(handle).toHaveAttribute('aria-valuenow', '340');
  // The timeline moves along with the column, and day lookups follow it.
  const after = (await bar(page, 'Weld keel').boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(100);
  await page.mouse.move(after.x + DAY_PX / 2, after.y - 40);
  await expect(page.getByRole('button', { name: 'Shift the timeline from 1 Oct' })).toBeVisible();

  // It can't be dragged narrower than 150px or wider than 800px.
  box = (await handle.boundingBox())!;
  await dragBy(page, box.x + box.width / 2, box.y + 20, -400);
  await expect(header).toHaveCSS('width', '150px');
  box = (await handle.boundingBox())!;
  await dragBy(page, box.x + box.width / 2, box.y + 20, 1000);
  await expect(header).toHaveCSS('width', '800px');

  // Escape cancels a drag; double-clicking resets the width; arrow keys nudge it.
  box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + 20, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(header).toHaveCSS('width', '800px');
  await handle.dblclick();
  await expect(header).toHaveCSS('width', '240px');
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(header).toHaveCSS('width', '256px');
});
