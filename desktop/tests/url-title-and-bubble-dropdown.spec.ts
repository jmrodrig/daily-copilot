import { test, expect, type Locator, type Page } from '@playwright/test';

/** Dispatch a paste of `text` (as plain text) on `target`. */
async function paste(target: Locator, text: string) {
  await target.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/** Mock one note (and what the editor's menus load); returns the bodies of its saves. */
async function setupNote(page: Page, content: string, titles: Record<string, string | null> = {}) {
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
  await page.route('**/api/url-metadata*', (route) => {
    const url = new URL(route.request().url()).searchParams.get('url') ?? '';
    return route.fulfill({ json: { title: titles[url] ?? null } });
  });
  await page.goto('http://localhost:5173/note?space=1&path=C7801/test.md');
  return { saved };
}

/** Select characters `from`..`to` of the editor's first paragraph. */
async function select(page: Page, from: number, to: number) {
  const editor = page.locator('.note-body');
  await editor.click();
  await editor.evaluate((_el, [start, end]) => {
    const text = document.querySelector('.note-body p, .note-body h1, .note-body h2')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, [from, to]);
}

test('the selection menu picks the block type from one compact dropdown', async ({ page }) => {
  const { saved } = await setupNote(page, 'Hull lines review');
  await select(page, 0, 4); // "Hull"

  const bar = page.getByRole('toolbar', { name: 'Format selection' });
  const trigger = bar.getByRole('button', { name: /Text format/ });
  await expect(trigger).toHaveText('T▾');
  await expect(bar.getByRole('button', { name: 'Heading 1' })).toHaveCount(0);

  await trigger.click();
  const options = bar.getByRole('option');
  await expect(options).toHaveText([/Normal text/, /Heading 1/, /Heading 2/, /Heading 3/]);
  await expect(bar.getByRole('option', { name: /Normal text/ })).toHaveAttribute('aria-selected', 'true');

  await bar.getByRole('option', { name: /Heading 1/ }).click();
  await expect(page.locator('.note-body h1')).toHaveText('Hull lines review');
  await expect(trigger).toHaveText('H1▾');
  await expect(options).toHaveCount(0);

  // The selection is kept, and picking the current type again leaves it as it is.
  await trigger.click();
  await bar.getByRole('option', { name: /Heading 1/ }).click();
  await expect(page.locator('.note-body h1')).toHaveText('Hull lines review');

  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);

  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toMatch(/^# Hull lines review/m);
});

test('a URL pasted into a note is labelled with its page title once it comes back', async ({ page }) => {
  const { saved } = await setupNote(page, 'See ', { 'https://github.com': 'GitHub · Build and ship software' });
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');
  await paste(editor, 'https://github.com');

  await expect(editor.locator('.reference-pill.url')).toHaveText('GitHub · Build and ship software');
  await expect
    .poll(() => saved.at(-1) ?? '', { timeout: 6000 })
    .toContain('[GitHub · Build and ship software](https://github.com "ref:url")');

  // Not an edit of its own: undo takes the pasted pill away with its title.
  await page.keyboard.press('Control+z');
  await expect(editor.locator('.reference-pill.url')).toHaveCount(0);
});

const PUBLICO = 'https://www.publico.pt/2026/10/17/sociedade/noticia/2025-quase-metade-vagas-incentivos-medicos-ficou-preencher-2191629';
const PUBLICO_TITLE = '2025 quase metade vagas incentivos medicos ficou preencher · Público';

test('a URL whose page has no title is labelled from its slug', async ({ page }) => {
  // As when the site's WAF turns the backend away and it has nothing to say: the URL itself makes the title.
  const { saved } = await setupNote(page, 'Read ');
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');
  await paste(editor, PUBLICO);

  await expect(editor.locator('.reference-pill.url')).toHaveText(PUBLICO_TITLE);
  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toContain(`[${PUBLICO_TITLE}](${PUBLICO} "ref:url")`);
});

test('a URL is labelled from its slug when the backend cannot be reached', async ({ page }) => {
  await setupNote(page, 'Read ');
  await page.route('**/api/url-metadata*', (route) => route.abort());
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('End');
  await paste(editor, 'https://www.theverge.com/2024/3/15/24101234/apple-antitrust-lawsuit-doj-iphone');

  await expect(editor.locator('.reference-pill.url')).toHaveText('Apple antitrust lawsuit doj iphone · The Verge');
});

test('a URL pasted over selected text keeps that text as its label', async ({ page }) => {
  await setupNote(page, 'Search on Google today', { 'https://google.com': 'Google Search' });
  await select(page, 10, 16); // "Google"
  await paste(page.locator('.note-body'), 'https://google.com');

  await expect(page.locator('.note-body .reference-pill.url')).toHaveText('Google');
});

test('a URL pasted into a comment is labelled with its page title', async ({ page }) => {
  const task = {
    id: 7, space_id: 1, project_id: 1, project_code: 'C7801', title: 'Order the steel', description: '', status: 'todo',
    priority: 'normal', assignee: null, start_date: null, deadline: null, completion_percent: 0, is_gantt_task: false,
    is_milestone: false, tags: [], note_path: null, comments: [], custom_fields: {},
  };
  await page.route('**/api/tasks?*', (route) => route.fulfill({ json: [task] }));
  await page.route('**/api/tasks/7', (route) => route.fulfill({ json: task }));
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [{ id: 1, code: 'C7801', name: 'Bridge', folder_path: 'C7801' }] }));
  await page.route('**/api/spaces/1/tags', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/spaces', (route) => route.fulfill({ json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [] }] }));
  await page.route('**/api/people?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/url-metadata*', (route) => route.fulfill({ json: { title: 'Supplier quote' } }));
  await page.goto('http://localhost:5173/tasks/kanban?taskId=7');

  const box = page.getByRole('region', { name: 'Task details' }).getByLabel('New comment');
  await box.fill('Quote: ');
  await box.press('End');
  await paste(box, 'https://supplier.example/quote');
  await expect(box).toHaveValue('Quote: [Supplier quote](https://supplier.example/quote "ref:url")');

  // Typing carries on after the pill.
  await page.keyboard.type(' thanks');
  await expect(box).toHaveValue('Quote: [Supplier quote](https://supplier.example/quote "ref:url") thanks');
});
