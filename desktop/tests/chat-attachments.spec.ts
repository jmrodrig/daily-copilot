import { test, expect, type Page } from '@playwright/test';

const ASSET = '0123456789abcdef0123456789abcdef.pdf';
const ASSET_URL = `/api/notes/image/${ASSET}?space_id=1`;

async function mockApp(page: Page) {
  await page.route('**/api/spaces*', (route) =>
    route.fulfill({
      json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [], status_colors: {} }],
    })
  );
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/prompts*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/models*', (route) => route.fulfill({ json: ['claude-opus-5-5'] }));
  await page.route('**/health', (route) => route.fulfill({ json: { chat_model: 'claude-opus-5-5' } }));
  await page.route('**/api/chat/history*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { space_id: 1, threads: [], active_id: null } })
      : route.fulfill({ json: route.request().postDataJSON() })
  );
}

test('a file attached in the chat is uploaded, shown as a pill, sent with the question and opens in the lightbox', async ({ page }) => {
  await mockApp(page);
  let uploads = 0;
  await page.route((url) => url.pathname === '/api/notes/image', (route) => {
    uploads += 1;
    return route.fulfill({ json: { url: ASSET_URL } });
  });
  await page.route((url) => url.pathname === `/api/notes/image/${ASSET}`, (route) =>
    route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4 fake' })
  );
  await page.route((url) => url.pathname === `/api/notes/image/${ASSET}/markup`, (route) =>
    route.fulfill({ json: { strokes: [], comments: [] } })
  );
  let streamBody: { messages: { role: string; content: string; attachments: unknown[] }[] } | null = null;
  await page.route((url) => url.pathname === '/api/chat/stream', (route) => {
    streamBody = route.request().postDataJSON();
    const done = { type: 'done', response: { reply: 'It covers the hull scantlings.', proposed_edits: [], written_paths: [], tool_calls: [] } };
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify(done) + '\n' });
  });

  await page.goto('http://localhost:5173/');
  const composer = page.getByTestId('chat-composer');
  const file = { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048) };

  // Attach, then remove it.
  await composer.locator('input[type="file"]').setInputFiles(file);
  const chips = composer.getByLabel('Attached files');
  await expect(chips.getByText('report.pdf')).toBeVisible();
  await expect(chips.getByText('2 KB')).toBeVisible();
  await chips.getByRole('button', { name: 'Remove report.pdf' }).click();
  await expect(composer.getByText('report.pdf')).toHaveCount(0);

  // Attach again and send.
  await composer.locator('input[type="file"]').setInputFiles(file);
  await expect(chips.getByText('report.pdf')).toBeVisible();
  expect(uploads).toBe(2);
  await page.getByRole('textbox', { name: 'Ask a question' }).fill('Please summarize this document');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('It covers the hull scantlings.')).toBeVisible();
  expect(streamBody).not.toBeNull();
  const question = streamBody!.messages[streamBody!.messages.length - 1];
  expect(question.attachments).toEqual([{ name: 'report.pdf', url: ASSET_URL, size: 2048, content_type: 'application/pdf' }]);
  // The composer is cleared; the question shows its pill.
  await expect(composer.locator('[data-attachment="report.pdf"]')).toHaveCount(0);
  const pill = page.locator('[data-attachment="report.pdf"]');
  await expect(pill).toHaveCount(1);

  // The pill opens the PDF in the lightbox.
  await pill.getByRole('button', { name: 'Open report.pdf' }).click();
  await expect(page.getByRole('dialog', { name: 'report.pdf' })).toBeVisible();
});

test('a file pasted in the chat input is attached', async ({ page }) => {
  await mockApp(page);
  await page.route((url) => url.pathname === '/api/notes/image', (route) =>
    route.fulfill({ json: { url: '/api/notes/image/fedcba9876543210fedcba9876543210.png?space_id=1' } })
  );

  await page.goto('http://localhost:5173/');
  const input = page.getByRole('textbox', { name: 'Ask a question' });
  await input.focus();
  await input.evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'sketch.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await expect(page.getByTestId('chat-composer').getByLabel('Attached files').getByText('sketch.png')).toBeVisible();
  await expect(input).toHaveValue('');
});
