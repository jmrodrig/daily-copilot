import { test, expect } from '@playwright/test';

test('reproduce contentMatchAt error when uploading file', async ({ page }) => {
  await page.route('/api/notes/file*', async (route) => {
    await route.fulfill({
      json: {
        path: 'test.md',
        frontmatter: { state: 'draft' },
        content: ''
      }
    });
  });
  
  await page.route('/api/tasks*', async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route('/api/notes/image', async (route) => {
    await route.fulfill({ json: { url: 'fake-url.pdf' } });
  });

  await page.goto('http://localhost:5173/note?space=1&path=test.md');
  
  await page.waitForSelector('.note-body');
  
  const editor = page.locator('.note-body');
  
  // Seed the editor with a paragraph of text followed by an image
  await editor.fill('First paragraph');
  await page.keyboard.press('Enter');
  
  // Type an image markdown and space to trigger input rule
  await page.keyboard.type('![alt](https://example.com/image.png)');
  await page.keyboard.press('Space');
  
  // Wait for the image to render
  await page.waitForSelector('.note-media img');

  // Listen for the unhandled exception before clicking
  let errorOccurred = false;
  page.on('pageerror', (err) => {
    console.error('Page error:', err.message);
    if (err.message.includes('contentMatchAt')) {
      errorOccurred = true;
    }
  });

  // Select the image
  await page.locator('.note-media img').click();

  // Trigger the toolbar attachment upload with a PDF file
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.locator('[aria-label="Attach file"]').click();
  const fileChooser = await fileChooserPromise;
  
  // Create a fake PDF file
  await fileChooser.setFiles({
    name: 'document.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('fake pdf content')
  });

  // Wait for the upload to complete and see if it crashes
  await page.waitForTimeout(2000);
  
  expect(errorOccurred).toBe(true);
});
