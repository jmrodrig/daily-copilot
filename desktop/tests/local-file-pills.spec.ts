import { test, expect, type Page } from '@playwright/test';
import { protocolUrl } from '../src/lib/localFiles';

const MANUAL = String.raw`\\SYFILEAPP1\Shared\Spirit 44E\Owner's Manual.pdf`;
const PLANS = String.raw`\\SYFILEAPP1\Shared\Spirit 44E\Plans`;
const GONE = String.raw`\\SYFILEAPP1\Shared\Spirit 44E\gone.pdf`;
const MANUAL_PILL = String.raw`[Owner's Manual.pdf](\\SYFILEAPP1\Shared\Spirit%2044E\Owner's%20Manual.pdf "ref:url")`;

/** Mock the note and the local-file APIs; returns the saved bodies and the paths opened through the backend. */
async function setup(page: Page, content: string, state = 'draft') {
  const saved: string[] = [];
  const opened: string[] = [];
  const checked: string[] = [];
  await page.route('**/api/notes/file*', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      saved.push(body.content);
      return route.fulfill({ json: { path: 'C7801/test.md', frontmatter: { state: 'draft' }, content: body.content } });
    }
    return route.fulfill({ json: { path: 'C7801/test.md', frontmatter: { state }, content } });
  });
  await page.route('**/api/tasks*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/notes/recent*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/local-files/check*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    checked.push(path);
    const exists = !path.includes('gone');
    return route.fulfill({
      json: { exists, path, name: exists ? path.split('\\').pop() : null, type: exists ? 'file' : null, unc_path: exists ? path : null },
    });
  });
  await page.route('**/api/local-files/open', (route) => {
    opened.push(route.request().postDataJSON().path);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('http://localhost:5173/note?space=1&path=C7801/test.md');
  return { saved, opened, checked };
}

/** Paste into the editor at its end, as Ctrl+V would, with the clipboard holding `data` (by MIME type). */
async function paste(page: Page, data: Record<string, string>) {
  const editor = page.locator('.note-body');
  await editor.click();
  await page.keyboard.press('Control+End');
  await editor.evaluate((el, data) => {
    const clipboardData = new DataTransfer();
    for (const [type, value] of Object.entries(data)) clipboardData.setData(type, value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, data);
}

test('pasted inline code and links holding local paths found on disk become link pills', async ({ page }) => {
  const { saved, checked } = await setup(page, 'Files:');
  await paste(page, {
    'text/html': `<p>See <code>${MANUAL}</code>, <code>C44E AVVENTO.md</code>, <code>${GONE}</code> and <a href="${PLANS}">the plans</a>.</p>`,
    'text/plain': 'ignored',
  });

  const pills = page.locator('.note-body .reference-pill.url');
  await expect(pills).toHaveText(["Owner's Manual.pdf", 'the plans']);
  await expect(pills.first()).toHaveAttribute('data-href', MANUAL);
  // Not a local path, and a path not found: left as code.
  await expect(page.locator('.note-body code')).toHaveText(['C44E AVVENTO.md', GONE]);
  expect(checked).not.toContain('C44E AVVENTO.md');

  await expect.poll(() => saved.at(-1) ?? '', { timeout: 6000 }).toContain(MANUAL_PILL);
  expect(saved.at(-1)).toContain(String.raw`[the plans](\\SYFILEAPP1\Shared\Spirit%2044E\Plans "ref:url")`);
  expect(saved.at(-1)).toContain('`C44E AVVENTO.md`');
});

test('local paths in markdown pasted as plain text become link pills too', async ({ page }) => {
  await setup(page, 'Files:');
  await paste(page, { 'text/plain': `- \`${MANUAL}\` *(manual)*\n- \`${GONE}\`` });

  await expect(page.locator('.note-body .reference-pill.url')).toHaveText(["Owner's Manual.pdf"]);
  await expect(page.locator('.note-body code')).toHaveText([GONE]);
});

test('clicking a local file pill in a draft selects it; its menu\'s Open opens the file', async ({ page }) => {
  const { opened } = await setup(page, `See ${MANUAL_PILL} here.`);
  const pill = page.locator('.note-body .reference-pill.url');
  await expect(pill).toHaveAttribute('data-href', MANUAL);

  await pill.click();
  await expect(pill).toHaveClass(/selected/);
  const open = page.getByRole('link', { name: 'Open' });
  await expect(open).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(opened).toEqual([]);

  await open.click();
  await expect.poll(() => opened).toEqual([MANUAL]);
  await expect(page).toHaveURL(/\/note\?/);
});

test('a published note shows a UNC pill as a local file link, opening the file on click', async ({ page }) => {
  const { opened } = await setup(page, `See ${MANUAL_PILL} here.`, 'published');
  const link = page.locator('a.reference-pill.url');
  await expect(link).toHaveText("Owner's Manual.pdf");
  await expect(link).toHaveAttribute('href', MANUAL);
  await expect(link).toHaveAttribute('title', MANUAL);

  await link.click();
  await expect.poll(() => opened).toEqual([MANUAL]);
});

test('protocolUrl encodes the linked and UNC paths into a copilot-open: link', () => {
  const mapped = String.raw`Y:\Spirit 44E\Owner's (1) [1] & co.pdf`;
  const unc = String.raw`\\SYFILEAPP1\Shared\Spirit 44E\Owner's (1) [1] & co.pdf`;
  const encoded = 'Spirit%2044E%5COwner%27s%20%281%29%20%5B1%5D%20%26%20co.pdf';

  expect(protocolUrl(mapped, unc)).toBe(`copilot-open://open?path=Y%3A%5C${encoded}&unc=%5C%5CSYFILEAPP1%5CShared%5C${encoded}`);
  expect(protocolUrl(unc, unc)).toBe(`copilot-open://open?path=%5C%5CSYFILEAPP1%5CShared%5C${encoded}`);
  expect(protocolUrl(mapped, null)).toBe(`copilot-open://open?path=Y%3A%5C${encoded}`);
  expect(protocolUrl(mapped, unc, 'https://designer.tailf76a98.ts.net')).toBe(
    `copilot-open://open?path=Y%3A%5C${encoded}&unc=%5C%5CSYFILEAPP1%5CShared%5C${encoded}&origin=https%3A%2F%2Fdesigner.tailf76a98.ts.net`,
  );
});
