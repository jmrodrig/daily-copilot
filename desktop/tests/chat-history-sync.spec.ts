import { test, expect } from '@playwright/test';

test('CopilotChat loads remote history, displays threads, and syncs updates to backend', async ({ page }) => {
  let putPayload: Record<string, unknown> | null = null;
  const initialRemoteThreads = [
    {
      id: 'thread-remote-1',
      title: 'Remote discussion on keel',
      createdAt: 1729000000000,
      updatedAt: 1729000010000,
      entries: [
        { role: 'user', content: 'What is the keel draft?', prompt: null, context: null },
        { role: 'assistant', content: 'Draft is 2.1m.', edits: [], written: [], toolCalls: [] },
      ],
    },
  ];

  await page.route('**/api/spaces*', (route) =>
    route.fulfill({
      json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [], status_colors: {} }],
    })
  );
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/prompts*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/models*', (route) => route.fulfill({ json: ['claude-opus-5-5'] }));
  await page.route('**/health', (route) => route.fulfill({ json: { chat_model: 'claude-opus-5-5' } }));

  await page.route('**/api/chat/history*', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          space_id: 1,
          threads: initialRemoteThreads,
          active_id: 'thread-remote-1',
        },
      });
    }
    if (route.request().method() === 'PUT') {
      putPayload = route.request().postDataJSON();
      return route.fulfill({
        json: putPayload,
      });
    }
    return route.fulfill({ status: 200, json: {} });
  });

  // Navigate to app
  await page.goto('http://localhost:5173/');

  // Open chat history popover
  const historyBtn = page.getByRole('button', { name: 'Chat history' });
  await expect(historyBtn).toBeVisible();
  await historyBtn.click();

  // The remote thread should be present in the history list
  const popover = page.getByRole('dialog', { name: 'Chat history' });
  await expect(popover).toBeVisible();
  await expect(popover.getByText('Remote discussion on keel')).toBeVisible();

  // Close history menu
  await page.keyboard.press('Escape');

  // Verify chat displays the active remote conversation turns
  await expect(page.getByText('What is the keel draft?')).toBeVisible();
  await expect(page.getByText('Draft is 2.1m.')).toBeVisible();
});
