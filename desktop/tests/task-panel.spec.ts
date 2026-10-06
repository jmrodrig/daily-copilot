import { test, expect, type Page } from '@playwright/test';

const TASK = {
  id: 7, space_id: 1, project_id: 1, project_code: 'C7801', title: 'Order the steel', description: 'Grade S355', status: 'todo',
  priority: 'normal', assignee: null, start_date: '2026-10-01', deadline: '2026-10-20', completion_percent: 0, is_gantt_task: false,
  is_milestone: false, tags: [], note_path: null, comments: [] as Record<string, unknown>[],
};

/** Mock the task APIs around one task; returns the PATCH and comment bodies sent. */
async function setup(page: Page, path: string) {
  const task = { ...TASK, comments: [...TASK.comments] };
  const patches: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  await page.route('**/api/tasks?*', (route) => route.fulfill({ json: [task] }));
  await page.route('**/api/tasks/7', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      Object.assign(task, body);
    }
    return route.fulfill({ json: task });
  });
  await page.route('**/api/tasks/7/comments', async (route) => {
    const body = route.request().postDataJSON();
    comments.push(body);
    task.comments.push({ id: 'c1', author: body.author, text: body.text, created_at: '2026-10-06T09:30:00', updated_at: null });
    return route.fulfill({ status: 201, json: task });
  });
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [{ id: 1, code: 'C7801', name: 'Bridge', folder_path: 'C7801' }] }));
  await page.route('**/api/spaces/1/tags', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes?*', (route) => route.fulfill({ json: [] }));
  await page.goto(`http://localhost:5173${path}`);
  return { patches, comments };
}

test('clicking a Kanban card opens it above the chat; description and comments save', async ({ page }) => {
  const { patches, comments } = await setup(page, '/tasks/kanban');
  await page.getByText('Order the steel').click();
  await expect(page).toHaveURL(/taskId=7/);

  const panel = page.getByRole('region', { name: 'Task details' });
  await expect(panel.getByLabel('Title')).toHaveValue('Order the steel');
  // The chat stays in the panel, below the task.
  await expect(page.getByRole('region', { name: 'Ask the knowledge base' })).toBeVisible();

  const description = panel.getByLabel('Description');
  await description.fill('Grade S355, 40 t');
  await panel.getByLabel('Title').focus();
  await expect.poll(() => patches.at(-1)).toEqual({ description: 'Grade S355, 40 t' });

  await panel.getByLabel('New comment').fill('Quote requested');
  await panel.getByRole('button', { name: 'Comment' }).click();
  await expect.poll(() => comments.at(-1)).toMatchObject({ text: 'Quote requested' });
  await expect(panel.getByText('Quote requested')).toBeVisible();
  await expect(panel.getByText('Comments (1)')).toBeVisible();
});

test('changing a card status from its select does not open the task', async ({ page }) => {
  const { patches } = await setup(page, '/tasks/kanban');
  await page.getByLabel('Status of Order the steel').selectOption('done');
  await expect.poll(() => patches.at(-1)).toEqual({ status: 'done' });
  await expect(page).not.toHaveURL(/taskId=/);
});

test('backlog and Gantt rows open the task panel', async ({ page }) => {
  await setup(page, '/tasks/backlog');
  await page.getByRole('button', { name: /Order the steel/ }).click();
  await expect(page.getByRole('region', { name: 'Task details' }).getByLabel('Title')).toHaveValue('Order the steel');

  // Switching view keeps the open task.
  await page.getByRole('navigation', { name: 'Task views' }).getByRole('link', { name: 'Gantt' }).click();
  await expect(page).toHaveURL(/\/tasks\/gantt\?.*taskId=7/);
  await page.getByRole('button', { name: 'Close task' }).click();
  await expect(page).not.toHaveURL(/taskId=/);
  await page.getByRole('button', { name: 'Order the steel' }).click();
  await expect(page).toHaveURL(/taskId=7/);
});
