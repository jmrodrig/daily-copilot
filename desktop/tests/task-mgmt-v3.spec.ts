import { test, expect, type Page } from '@playwright/test';

const YARD = {
  id: 'yard', name: 'Yard', type: 'dropdown', options: ['North', 'South', 'East'], colors: { North: '#6cb6ea', South: '#e5677d' },
};
const HULL = { id: 'hull', name: 'Hull no.', type: 'text', options: [], colors: {} };

const TASK = {
  space_id: 1, project_id: 1, project_code: 'C7801', project_color: '#56c8a8', description: '', status: 'todo', priority: 'normal',
  assignee: null, start_date: '2026-10-01', deadline: '2026-10-20', completion_percent: 0, is_gantt_task: false, is_milestone: false,
  tags: [], note_path: null, comments: [],
};
const TASKS = [
  { ...TASK, id: 1, title: 'Weld keel', custom_fields: { yard: 'North', hull: 'H-12' } },
  { ...TASK, id: 2, title: 'Paint deck', custom_fields: { yard: 'East' } },
];

/** Mock the task APIs; returns the task list queries and the space / project PUT bodies sent. */
async function setup(page: Page, path: string) {
  const queries: URLSearchParams[] = [];
  const spacePuts: Record<string, unknown>[] = [];
  const projectPuts: Record<string, unknown>[] = [];
  let space = { id: 1, name: 'Default', status_flow: null, custom_fields_schema: [YARD, HULL] as unknown[] };
  const project = { id: 1, code: 'C7801', name: 'Bridge', color: '#56c8a8', folder_path: 'C7801' };

  await page.route('**/api/tasks?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    // Enough of the server's filtering for these tests.
    const yard = params.getAll('cf').find((cf) => cf.startsWith('yard:'))?.slice(5);
    return route.fulfill({ json: yard === undefined ? TASKS : TASKS.filter((t) => t.custom_fields.yard === yard) });
  });
  await page.route('**/api/tasks/*', (route) => route.fulfill({ json: TASKS.find((t) => route.request().url().endsWith(`/${t.id}`)) }));
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [project] }));
  await page.route('**/api/projects/1', async (route) => {
    const body = route.request().postDataJSON();
    projectPuts.push(body);
    Object.assign(project, body);
    return route.fulfill({ json: { ...project, description: '', active: true } });
  });
  await page.route('**/api/spaces/1/tags', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/spaces', (route) => route.fulfill({ json: [space] }));
  await page.route('**/api/spaces/1', async (route) => {
    const body = route.request().postDataJSON();
    spacePuts.push(body);
    space = { ...space, ...body };
    return route.fulfill({ json: space });
  });
  await page.route('**/api/people?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes?*', (route) => route.fulfill({ json: [] }));
  await page.goto(`http://localhost:5173${path}`);
  return { queries, spacePuts, projectPuts };
}

test('cards show coloured dropdown values as pills, and the project in its colour', async ({ page }) => {
  await setup(page, '/tasks/kanban');
  const keel = page.locator('li', { hasText: 'Weld keel' });
  await expect(keel.getByText('North', { exact: true })).toHaveCSS('color', 'rgb(108, 182, 234)');
  await expect(keel.getByText('C7801')).toHaveCSS('color', 'rgb(86, 200, 168)');
  // East has no colour: no pill.
  await expect(page.locator('li', { hasText: 'Paint deck' }).getByText('East', { exact: true })).toHaveCount(0);
});

test('advanced filters are sent to the server and kept in the URL', async ({ page }) => {
  const { queries } = await setup(page, '/tasks/kanban');
  await page.getByText('Advanced filters').click();
  await page.getByLabel('Filter on Yard').selectOption('North');
  await expect(page).toHaveURL(/cf=yard%3ANorth/);
  await expect(page.getByText('Paint deck')).toHaveCount(0);

  await page.locator('label', { hasText: 'Due date' }).locator('select').selectOption('false');
  await page.getByLabel('Due on or after').fill('2026-10-01');
  await expect.poll(() => queries.at(-1)?.toString()).toBe('space_id=1&cf=yard%3ANorth&has_deadline=false&due_after=2026-10-01');

  // Reloading the bookmarked URL restores the filters, with the section open.
  await page.reload();
  await expect(page.getByLabel('Filter on Yard')).toHaveValue('North');
  await expect(page.locator('summary')).toHaveText('Advanced filters(3)');

  await page.getByRole('button', { name: 'Clear advanced filters' }).click();
  await expect(page).not.toHaveURL(/cf=|has_deadline|due_after/);
});

test('priority, status, flag and start date filters are sent to the server and kept in the URL', async ({ page }) => {
  const { queries } = await setup(page, '/tasks/list');
  await page.getByText('Advanced filters').click();
  await page.getByLabel('Priority').selectOption('high');
  await page.getByLabel('Status').selectOption('blocked');
  await page.getByLabel('Gantt task').selectOption('true');
  await page.getByLabel('Milestone').selectOption('false');
  await page.getByLabel('Linked note').selectOption('true');
  await page.getByLabel('Start on or after').fill('2026-09-01');
  await page.getByLabel('Start on or before').fill('2026-09-30');
  await expect
    .poll(() => queries.at(-1)?.toString())
    .toBe(
      'space_id=1&priority=high&status=blocked&is_gantt_task=true&is_milestone=false&has_note=true&start_after=2026-09-01&start_before=2026-09-30',
    );

  await page.reload();
  await expect(page.getByLabel('Status')).toHaveValue('blocked');
  await expect(page.locator('summary')).toHaveText('Advanced filters(7)');

  await page.getByRole('button', { name: 'Clear advanced filters' }).click();
  await expect(page).not.toHaveURL(/priority|status|is_gantt_task|is_milestone|has_note|start_after|start_before/);
});

test('text field filters apply on Enter', async ({ page }) => {
  const { queries } = await setup(page, '/tasks/list');
  await page.getByText('Advanced filters').click();
  await page.getByLabel('Filter on Hull no.').selectOption({ label: 'Contains…' });
  await page.getByLabel('Hull no. to match').fill('h-1');
  await page.getByLabel('Hull no. to match').press('Enter');
  await expect.poll(() => queries.at(-1)?.getAll('cf')).toEqual(['hull:h-1']);
});

test('the Gantt colours bars by project or by a dropdown field', async ({ page }) => {
  await setup(page, '/tasks/gantt');
  const bar = page.locator('[title^="Weld keel ·"] div').first();
  await expect(bar).toHaveCSS('border-color', 'rgb(86, 200, 168)');
  await page.getByLabel('Colour by').selectOption({ label: 'Yard' });
  await expect(bar).toHaveCSS('border-color', 'rgb(108, 182, 234)');
  await expect(page.getByRole('list', { name: 'Yard colours' })).toContainText('North');
});

test('editing a dropdown field renames options and sets their colours', async ({ page }) => {
  const { spacePuts } = await setup(page, '/space-preferences');
  await page.getByRole('button', { name: 'Edit Yard' }).click();
  await page.getByLabel('Option 1 of Yard').fill('Northern');
  await page.getByRole('group', { name: 'Colour of East' }).getByRole('button', { name: 'Amber' }).click();
  await page.getByRole('group', { name: 'Colour of South' }).getByRole('button', { name: 'No colour' }).click();
  await page.getByRole('region', { name: 'Custom fields' }).getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => spacePuts.at(-1)).toEqual({
    custom_fields_schema: [
      { ...YARD, options: ['Northern', 'South', 'East'], colors: { Northern: '#6cb6ea', East: '#e8b04b' } },
      HULL,
    ],
    renamed_options: { yard: { North: 'Northern' } },
  });
});

test('a project colour is set from Space preferences', async ({ page }) => {
  const { projectPuts } = await setup(page, '/space-preferences#projects');
  const row = page.getByRole('region', { name: 'Projects' }).locator('li', { hasText: 'C7801' });
  await row.getByLabel('Hex colour of C7801').fill('#B7A3F2');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => projectPuts.at(-1)).toEqual({ name: 'Bridge', color: '#b7a3f2' });
});

test('bulk edit sends only the ticked fields of the selected tasks', async ({ page }) => {
  await setup(page, '/tasks/list');
  const bulkBodies: Record<string, unknown>[] = [];
  await page.route('**/api/tasks/bulk-update', (route) => {
    bulkBodies.push(route.request().postDataJSON());
    return route.fulfill({ json: TASKS });
  });

  await page.getByLabel('Select all shown tasks').check();
  const toolbar = page.getByRole('toolbar', { name: 'Bulk actions' });
  await expect(toolbar).toContainText('2 selected');
  await expect(toolbar.locator('select')).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'Bulk edit…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Bulk edit' });
  await expect(dialog).toContainText('Bulk edit 2 tasks');
  const apply = dialog.getByRole('button', { name: 'Apply changes' });
  await expect(apply).toBeDisabled();

  await dialog.getByLabel('Change Priority').check();
  await dialog.getByLabel('New priority').selectOption('high');
  // Both tasks are due the same day, so the date starts there; "Clear date" empties it.
  await dialog.getByLabel('Change Due date').check();
  await expect(dialog.getByLabel('New due date')).toHaveValue('2026-10-20');
  await dialog.getByRole('button', { name: 'Clear date' }).click();
  await dialog.getByLabel('Change Gantt task').check();
  await dialog.getByLabel('New gantt task value').selectOption('true');
  await dialog.getByLabel('Change Yard').check();
  await dialog.getByLabel('New Yard').selectOption('South');
  await dialog.getByLabel('Change Hull no.').check();
  // Ticked then unticked: left alone.
  await dialog.getByLabel('Change Status').check();
  await dialog.getByLabel('Change Status').uncheck();
  await apply.click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => bulkBodies.at(-1)).toEqual({
    task_ids: [1, 2],
    updates: { priority: 'high', deadline: null, is_gantt_task: true, custom_fields: { yard: 'South', hull: null } },
  });
  await expect(page.getByRole('status')).toHaveText('Bulk edit: 2 tasks.');
});

test('the bulk edit dialog closes on Escape without saving', async ({ page }) => {
  await setup(page, '/tasks/list');
  let posted = false;
  await page.route('**/api/tasks/bulk-update', (route) => {
    posted = true;
    return route.fulfill({ json: TASKS });
  });
  await page.getByLabel('Select Weld keel').check();
  await page.getByRole('button', { name: 'Bulk edit…' }).click();
  await page.getByRole('dialog', { name: 'Bulk edit' }).getByLabel('Change Priority').check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(posted).toBe(false);
});
