# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests\upload.spec.ts >> reproduce contentMatchAt error when uploading file
- Location: tests\upload.spec.ts:3:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.waitForSelector: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.note-body') to be visible

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - navigation "Page tree" [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]:
        - generic [ref=e7]: Co-Pilot
        - button "Collapse page tree" [ref=e8] [cursor=pointer]
      - generic [ref=e12]:
        - generic [ref=e13]: Space
        - combobox "Space" [ref=e14] [cursor=pointer]:
          - option "Default" [selected]
          - option "+ New space…"
      - generic [ref=e15]:
        - link "Today" [ref=e16] [cursor=pointer]:
          - /url: /
        - link "Triage" [ref=e17] [cursor=pointer]:
          - /url: /triage
        - link "Forwarded emails" [ref=e18] [cursor=pointer]:
          - /url: /emails
        - link "Notes graph" [ref=e19] [cursor=pointer]:
          - /url: /graph
        - link "People" [ref=e20] [cursor=pointer]:
          - /url: /people
        - generic [ref=e21]:
          - generic [ref=e22]: TASKS
          - button "New task view" [ref=e24] [cursor=pointer]: +
        - generic [ref=e25]:
          - link "c78-01 Kanban" [ref=e26] [cursor=pointer]:
            - /url: /views/1
          - button "c78-01 Kanban options" [ref=e30] [cursor=pointer]: …
        - generic [ref=e31]:
          - link "Backlog" [ref=e32] [cursor=pointer]:
            - /url: /views/2
          - button "Backlog options" [ref=e36] [cursor=pointer]: …
        - generic [ref=e37]:
          - link "Gantt" [ref=e38] [cursor=pointer]:
            - /url: /views/3
          - button "Gantt options" [ref=e42] [cursor=pointer]: …
        - generic [ref=e43]:
          - generic [ref=e44]:
            - generic [ref=e45]: CONTENT
            - generic [ref=e46]:
              - button "New note" [ref=e47] [cursor=pointer]: +
              - button "New folder" [ref=e48] [cursor=pointer]
          - generic [ref=e51]:
            - button "Expand C7801" [ref=e52] [cursor=pointer]
            - button "C7801 Project" [ref=e55] [cursor=pointer]:
              - generic [ref=e58]: C7801
              - generic [ref=e59]: Project
            - generic [ref=e60]:
              - button "New in C7801" [ref=e61] [cursor=pointer]: +
              - button "C7801 options" [ref=e62] [cursor=pointer]: …
          - generic [ref=e63]:
            - button "Expand Inbox" [ref=e64] [cursor=pointer]
            - button "Inbox" [ref=e67] [cursor=pointer]
            - generic [ref=e71]:
              - button "New in Inbox" [ref=e72] [cursor=pointer]: +
              - button "Inbox options" [ref=e73] [cursor=pointer]: …
          - generic [ref=e74]:
            - button "Expand R5301" [ref=e75] [cursor=pointer]
            - button "R5301 Project" [ref=e78] [cursor=pointer]:
              - generic [ref=e81]: R5301
              - generic [ref=e82]: Project
            - generic [ref=e83]:
              - button "New in R5301" [ref=e84] [cursor=pointer]: +
              - button "R5301 options" [ref=e85] [cursor=pointer]: …
        - generic [ref=e86]: TEMPLATES
        - link "Design decision" [ref=e88] [cursor=pointer]:
          - /url: /note?space=1&path=Design+decision.md&root=templates
        - link "Meeting note" [ref=e92] [cursor=pointer]:
          - /url: /note?space=1&path=Meeting+note.md&root=templates
      - generic [ref=e96]:
        - generic [ref=e97]:
          - generic [ref=e98]: Backend online
          - generic [ref=e100]: localhost:5173
        - link "Settings" [ref=e101] [cursor=pointer]:
          - /url: /settings
  - main [ref=e102]:
    - generic [ref=e103]:
      - generic [ref=e104]: NOTES
      - heading "test" [level=1] [ref=e107]
      - paragraph [ref=e108]: Could not open test.md (No note at test.md).
  - complementary "Ask the knowledge base" [ref=e109]:
    - generic [ref=e110]:
      - heading "Ask the knowledge base" [level=2] [ref=e111]
      - button "Collapse chat" [ref=e112] [cursor=pointer]
    - generic [ref=e115]:
      - generic [ref=e116]:
        - generic "gemini/gemini-3.1-pro-preview" [ref=e117]: gemini-3.1-pro-preview
        - button "Clear" [disabled] [ref=e119]
      - group "Access to notes" [ref=e120]:
        - button "Read only" [ref=e121] [cursor=pointer]
        - button "Ask first" [pressed] [ref=e122] [cursor=pointer]
        - button "Write directly" [ref=e123] [cursor=pointer]
    - generic [ref=e124]:
      - generic [ref=e125]:
        - generic [ref=e126]: "Space: Default"
        - generic [ref=e127]: "Context: test"
        - generic [ref=e128]: "Notes: asks before writing"
      - paragraph [ref=e129]: Ask about your projects and notes, e.g. “What is overdue on C7801?”. Type / for your saved commands.
    - generic [ref=e130]:
      - generic [ref=e131]:
        - generic [ref=e132]: Ask a question
        - textbox "Ask a question" [active] [ref=e133]:
          - /placeholder: Ask, or type / for commands
      - button "Send" [disabled] [ref=e134]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test('reproduce contentMatchAt error when uploading file', async ({ page }) => {
  4  |   await page.route('/api/notes/file*', async (route) => {
  5  |     await route.fulfill({
  6  |       json: {
  7  |         path: 'test.md',
  8  |         frontmatter: { state: 'draft' },
  9  |         content: ''
  10 |       }
  11 |     });
  12 |   });
  13 |   
  14 |   await page.route('/api/tasks*', async (route) => {
  15 |     await route.fulfill({ json: [] });
  16 |   });
  17 | 
  18 |   await page.route('/api/notes/image', async (route) => {
  19 |     await route.fulfill({ json: { url: 'fake-url.pdf' } });
  20 |   });
  21 | 
  22 |   await page.goto('http://localhost:5173/note?space=1&path=test.md');
  23 |   
> 24 |   await page.waitForSelector('.note-body');
     |              ^ Error: page.waitForSelector: Test timeout of 30000ms exceeded.
  25 |   
  26 |   const editor = page.locator('.note-body');
  27 |   
  28 |   // Seed the editor with a paragraph of text followed by an image
  29 |   await editor.fill('First paragraph');
  30 |   await page.keyboard.press('Enter');
  31 |   
  32 |   // Type an image markdown and space to trigger input rule
  33 |   await page.keyboard.type('![alt](https://example.com/image.png)');
  34 |   await page.keyboard.press('Space');
  35 |   
  36 |   // Wait for the image to render
  37 |   await page.waitForSelector('.note-media img');
  38 | 
  39 |   // Listen for the unhandled exception before clicking
  40 |   let errorOccurred = false;
  41 |   page.on('pageerror', (err) => {
  42 |     console.error('Page error:', err.message);
  43 |     if (err.message.includes('contentMatchAt')) {
  44 |       errorOccurred = true;
  45 |     }
  46 |   });
  47 | 
  48 |   // Select the image
  49 |   await page.locator('.note-media img').click();
  50 | 
  51 |   // Trigger the toolbar attachment upload with a PDF file
  52 |   const fileChooserPromise = page.waitForEvent('filechooser');
  53 |   await page.locator('[aria-label="Attach file"]').click();
  54 |   const fileChooser = await fileChooserPromise;
  55 |   
  56 |   // Create a fake PDF file
  57 |   await fileChooser.setFiles({
  58 |     name: 'document.pdf',
  59 |     mimeType: 'application/pdf',
  60 |     buffer: Buffer.from('fake pdf content')
  61 |   });
  62 | 
  63 |   // Wait for the upload to complete and see if it crashes
  64 |   await page.waitForTimeout(2000);
  65 |   
  66 |   expect(errorOccurred).toBe(true);
  67 | });
  68 | 
```