import { test, expect, type Page } from '@playwright/test';

test('NotePage automatically reloads when notifyNoteUpdated is fired and note is clean', async ({ page }) => {
  let noteContent = 'Initial content';
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({ json: [] }));
  await page.route((url) => url.pathname === '/api/notes/file', async (route) => {
    await route.fulfill({
      json: {
        path: 'Projects/Test.md',
        frontmatter: { title: 'Test Note', state: 'published' },
        content: noteContent,
      },
    });
  });

  await page.goto('http://localhost:5173/note?space=1&path=Projects/Test.md');
  await expect(page.locator('.note-body')).toContainText('Initial content');

  // Change content on disk/mock
  noteContent = 'Updated content from Co-pilot';

  // Dispatch note update event
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('copilot:note-updated', {
        detail: { spaceId: 1, path: 'Projects/Test.md' },
      })
    );
  });

  // Verify that NotePage automatically refreshed and displays the new content
  await expect(page.locator('.note-body')).toContainText('Updated content from Co-pilot');
});

test('NotePage shows conflict banner when external update happens while user has unsaved draft', async ({ page }) => {
  let noteContent = 'Initial draft content';
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({ json: [] }));
  await page.route((url) => url.pathname === '/api/notes/file', async (route) => {
    await route.fulfill({
      json: {
        path: 'Projects/Draft.md',
        frontmatter: { title: 'Draft Note', state: 'draft' },
        content: noteContent,
      },
    });
  });

  await page.goto('http://localhost:5173/note?space=1&path=Projects/Draft.md');
  await expect(page.locator('.ProseMirror')).toBeVisible();

  // Make the editor dirty by typing in it
  await page.locator('.ProseMirror').fill('User typing unsaved edits here');

  // External update arrives
  noteContent = 'Disk updated version';
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('copilot:note-updated', {
        detail: { spaceId: 1, path: 'Projects/Draft.md' },
      })
    );
  });

  // Should show the warning banner
  await expect(page.getByText('Co-pilot updated this note on disk.')).toBeVisible();
  const reloadBtn = page.getByRole('button', { name: 'Reload to view changes' });
  await expect(reloadBtn).toBeVisible();

  // Click reload
  await reloadBtn.click();
  await expect(page.getByText('Co-pilot updated this note on disk.')).not.toBeVisible();
  await expect(page.locator('.ProseMirror')).toContainText('Disk updated version');
});

test('CopilotChat displays progressive payout with Thinking, Answering, and Finished phases', async ({ page }) => {
  // Mock models and prompts
  await page.route((url) => url.pathname === '/api/models', (route) => route.fulfill({ json: ['gemini-2.5-pro'] }));
  await page.route((url) => url.pathname === '/api/prompts', (route) => route.fulfill({ json: [] }));
  await page.route((url) => url.pathname === '/health', (route) => route.fulfill({ json: { chat_model: 'gemini-2.5-pro' } }));
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({ json: [] }));
  await page.route((url) => url.pathname === '/api/notes/file', (route) => route.fulfill({ json: { path: 'test.md', frontmatter: {}, content: '' } }));

  // Mock /api/chat/stream to return a simulated response without text_delta (bulk response like Gemini API)
  await page.route((url) => url.pathname === '/api/chat/stream', async (route) => {
    const stream = [
      JSON.stringify({ type: 'thought', subject: 'Analyzing query', text: 'Considering relevant information...' }),
      JSON.stringify({
        type: 'done',
        response: {
          reply: 'Here is the comprehensive yacht design specification and naval architectural summary.',
          proposed_edits: [],
          written_paths: [],
          tool_calls: [],
        },
      }),
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: stream,
    });
  });

  await page.goto('http://localhost:5173/note?space=1&path=test.md');

  // Locate chat input and send question
  const chatInput = page.locator('textarea[placeholder*="Ask"]').or(page.locator('section[aria-label="Ask the knowledge base"] textarea'));
  await expect(chatInput).toBeVisible();
  await chatInput.fill('Summarize naval specs');
  await chatInput.press('Enter');

  // Should see LiveActivityCard in answering phase or writing response badge
  await expect(page.getByText('Writing response')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Answering…')).toBeVisible();

  // Should see finished answering indicator permanently in chat
  await expect(page.locator('span', { hasText: 'Finished answering' })).toBeVisible({ timeout: 6000 });
});
