# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests\task-panel.spec.ts >> clicking a Kanban card opens it above the chat; description and comments save
- Location: tests\task-panel.spec.ts:39:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('region', { name: 'Ask the knowledge base' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('region', { name: 'Ask the knowledge base' }) with timeout 5000ms
  - waiting for getByRole('region', { name: 'Ask the knowledge base' })

```

```yaml
- navigation "Page tree":
  - text: Daily Copilot
  - button "Collapse page tree"
  - text: Space
  - combobox "Space":
    - option "Default" [selected]
    - option "+ New space…"
  - link "Today":
    - /url: /
  - link "Triage":
    - /url: /triage
  - link "Forwarded emails":
    - /url: /emails
  - link "Notes graph":
    - /url: /graph
  - link "People":
    - /url: /people
  - link "Space Preferences":
    - /url: /space-preferences
  - text: TASKS
  - button "New task view": +
  - link "Kanban":
    - /url: /views/1
  - button "Kanban options": …
  - link "Backlog":
    - /url: /views/2
  - button "Backlog options": …
  - link "Gantt":
    - /url: /views/3
  - button "Gantt options": …
  - text: CONTENT
  - button "New note": +
  - button "New folder"
  - paragraph: No notes yet.
  - text: TEMPLATES
  - link "Design decision":
    - /url: /note?space=1&path=Design+decision.md&root=templates
  - link "Meeting note":
    - /url: /note?space=1&path=Meeting+note.md&root=templates
  - text: Backend online localhost:5173
  - link "Settings":
    - /url: /settings
- separator "Resize page tree"
- main:
  - text: DEFAULT · KANBAN VIEW
  - heading "Kanban" [level=1]
  - text: Tasks from the task database. Drag cards between columns to change their status; click one for its details.
  - button "Save as view"
  - navigation "Task views":
    - link "Kanban":
      - /url: /tasks/kanban?taskId=7
    - link "Backlog":
      - /url: /tasks/backlog?taskId=7
    - link "Gantt":
      - /url: /tasks/gantt?taskId=7
    - link "List":
      - /url: /tasks/list?taskId=7
  - text: Project
  - combobox "Project":
    - option "All projects" [selected]
    - option "C7801 · Bridge"
  - text: Assignee
  - combobox "Assignee":
    - option "Everyone" [selected]
    - option "Unassigned"
    - option "Jose"
  - text: Tag
  - combobox "Tag":
    - option "All tags" [selected]
  - text: New task
  - textbox "New task":
    - /placeholder: What needs doing?
  - text: Project
  - combobox "Project":
    - option "No project" [selected]
    - option "C7801"
  - text: Assignee
  - textbox "Assignee":
    - /placeholder: Jose
  - text: Start
  - textbox "Start"
  - text: Due
  - textbox "Due"
  - button "Add to To do" [disabled]
  - region "Backlog":
    - heading "Backlog 0" [level=3]
    - list
  - region "To do":
    - heading "To do 1" [level=3]
    - list:
      - listitem "Click for details · drag to change status":
        - text: Order the steel C7801 20 Oct
        - combobox "Status of Order the steel":
          - option "Backlog"
          - option "To do" [selected]
          - option "In progress"
          - option "Blocked"
          - option "Done"
          - option "Archived"
  - region "In progress":
    - heading "In progress 0" [level=3]
    - list
  - region "Done":
    - heading "Done 0" [level=3]
    - list
- separator "Resize task details"
- complementary "Task details":
  - region "Task details":
    - text: "Task #7"
    - button "Close task": ×
    - textbox "Title": Order the steel
    - text: C7801 Status
    - combobox "Status":
      - option "Backlog"
      - option "To do" [selected]
      - option "In progress"
      - option "Blocked"
      - option "Done"
      - option "Archived"
    - text: Priority
    - combobox "Priority":
      - option "low"
      - option "normal" [selected]
      - option "high"
      - option "urgent"
    - text: Start
    - textbox "Start": 2026-10-01
    - text: Due
    - textbox "Due": 2026-10-20
    - text: Assignee
    - textbox "Assignee":
      - /placeholder: Unassigned
    - text: Linked note
    - button "Link a note"
    - text: Description
    - textbox "Description":
      - /placeholder: Add a description…
      - text: Grade S355
    - text: Comments (0)
    - textbox "New comment":
      - /placeholder: Write a comment… (Ctrl+Enter to post)
    - button "Comment" [disabled]
    - button "Delete task"
- complementary "Co-pilot":
  - button "Expand chat"
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | 
  3  | const TASK = {
  4  |   id: 7, space_id: 1, project_id: 1, project_code: 'C7801', title: 'Order the steel', description: 'Grade S355', status: 'todo',
  5  |   priority: 'normal', assignee: null, start_date: '2026-10-01', deadline: '2026-10-20', completion_percent: 0, is_gantt_task: false,
  6  |   is_milestone: false, tags: [], note_path: null, comments: [] as Record<string, unknown>[], custom_fields: {},
  7  | };
  8  | 
  9  | /** Mock the task APIs around one task; returns the PATCH and comment bodies sent. */
  10 | async function setup(page: Page, path: string) {
  11 |   const task = { ...TASK, comments: [...TASK.comments] };
  12 |   const patches: Record<string, unknown>[] = [];
  13 |   const comments: Record<string, unknown>[] = [];
  14 |   await page.route('**/api/tasks?*', (route) => route.fulfill({ json: [task] }));
  15 |   await page.route('**/api/tasks/7', async (route) => {
  16 |     if (route.request().method() === 'PATCH') {
  17 |       const body = route.request().postDataJSON();
  18 |       patches.push(body);
  19 |       Object.assign(task, body);
  20 |     }
  21 |     return route.fulfill({ json: task });
  22 |   });
  23 |   await page.route('**/api/tasks/7/comments', async (route) => {
  24 |     const body = route.request().postDataJSON();
  25 |     comments.push(body);
  26 |     task.comments.push({ id: 'c1', author: body.author, text: body.text, created_at: '2026-10-06T09:30:00', updated_at: null });
  27 |     return route.fulfill({ status: 201, json: task });
  28 |   });
  29 |   await page.route('**/api/projects*', (route) => route.fulfill({ json: [{ id: 1, code: 'C7801', name: 'Bridge', folder_path: 'C7801' }] }));
  30 |   await page.route('**/api/spaces/1/tags', (route) => route.fulfill({ json: [] }));
  31 |   await page.route('**/api/spaces', (route) =>
  32 |     route.fulfill({ json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [] }] }),
  33 |   );
  34 |   await page.route('**/api/notes?*', (route) => route.fulfill({ json: [] }));
  35 |   await page.goto(`http://localhost:5173${path}`);
  36 |   return { patches, comments };
  37 | }
  38 | 
  39 | test('clicking a Kanban card opens it above the chat; description and comments save', async ({ page }) => {
  40 |   const { patches, comments } = await setup(page, '/tasks/kanban');
  41 |   await page.getByText('Order the steel').click();
  42 |   await expect(page).toHaveURL(/taskId=7/);
  43 | 
  44 |   const panel = page.getByRole('region', { name: 'Task details' });
  45 |   await expect(panel.getByLabel('Title')).toHaveValue('Order the steel');
  46 |   // The chat stays in the panel, below the task.
> 47 |   await expect(page.getByRole('region', { name: 'Ask the knowledge base' })).toBeVisible();
     |                                                                              ^ Error: expect(locator).toBeVisible() failed
  48 | 
  49 |   const description = panel.getByLabel('Description');
  50 |   await description.fill('Grade S355, 40 t');
  51 |   await panel.getByLabel('Title').focus();
  52 |   await expect.poll(() => patches.at(-1)).toEqual({ description: 'Grade S355, 40 t' });
  53 | 
  54 |   await panel.getByLabel('New comment').fill('Quote requested');
  55 |   await panel.getByRole('button', { name: 'Comment' }).click();
  56 |   await expect.poll(() => comments.at(-1)).toMatchObject({ text: 'Quote requested' });
  57 |   await expect(panel.getByText('Quote requested')).toBeVisible();
  58 |   await expect(panel.getByText('Comments (1)')).toBeVisible();
  59 | });
  60 | 
  61 | test('changing a card status from its select does not open the task', async ({ page }) => {
  62 |   const { patches } = await setup(page, '/tasks/kanban');
  63 |   await page.getByLabel('Status of Order the steel').selectOption('done');
  64 |   await page.getByRole('dialog', { name: 'Change status' }).getByRole('button', { name: 'Skip comment' }).click();
  65 |   await expect.poll(() => patches.at(-1)).toEqual({ status: 'done' });
  66 |   await expect(page).not.toHaveURL(/taskId=/);
  67 | });
  68 | 
  69 | test('backlog and Gantt rows open the task panel', async ({ page }) => {
  70 |   await setup(page, '/tasks/backlog');
  71 |   await page.getByRole('button', { name: /Order the steel/ }).click();
  72 |   await expect(page.getByRole('region', { name: 'Task details' }).getByLabel('Title')).toHaveValue('Order the steel');
  73 | 
  74 |   // Switching view keeps the open task.
  75 |   await page.getByRole('navigation', { name: 'Task views' }).getByRole('link', { name: 'Gantt' }).click();
  76 |   await expect(page).toHaveURL(/\/tasks\/gantt\?.*taskId=7/);
  77 |   await page.getByRole('button', { name: 'Close task' }).click();
  78 |   await expect(page).not.toHaveURL(/taskId=/);
  79 |   await page.getByRole('button', { name: 'Order the steel' }).click();
  80 |   await expect(page).toHaveURL(/taskId=7/);
  81 | });
  82 | 
```