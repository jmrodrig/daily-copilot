import { test, expect, type Page } from '@playwright/test';

const ASSET = 'abcdefabcdefabcdefabcdefabcdefab.pdf';
const ASSET_URL = `/api/notes/image/${ASSET}?space_id=1`;

/** A valid PDF of `pages` letter-size pages, each saying its number. */
function multipagePdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function openPdf(page: Page) {
  await page.route('**/api/spaces*', (route) =>
    route.fulfill({
      json: [{ id: 1, name: 'Default', status_flow: null, custom_fields_schema: [], status_colors: {} }],
    })
  );
  await page.route('**/api/projects*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/prompts*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/models*', (route) => route.fulfill({ json: ['claude-opus-5-5'] }));
  await page.route('**/health', (route) => route.fulfill({ json: { chat_model: 'claude-opus-5-5' } }));
  const thread = {
    id: 't-pdf',
    title: 'Plans',
    createdAt: 1729000000000,
    updatedAt: 1729000010000,
    entries: [
      {
        role: 'user',
        content: 'Look at these plans',
        prompt: null,
        context: null,
        attachments: [{ name: 'plans.pdf', url: ASSET_URL, size: 4096, content_type: 'application/pdf' }],
      },
      { role: 'assistant', content: 'Three pages of plans.', edits: [], written: [], toolCalls: [] },
    ],
  };
  await page.route('**/api/chat/history*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { space_id: 1, threads: [thread], active_id: 't-pdf' } })
      : route.fulfill({ json: route.request().postDataJSON() })
  );
  await page.route((url) => url.pathname === `/api/notes/image/${ASSET}`, (route) =>
    route.fulfill({ contentType: 'application/pdf', body: multipagePdf(3) })
  );
  await page.route((url) => url.pathname === `/api/notes/image/${ASSET}/markup`, (route) =>
    route.fulfill({ json: { strokes: [], comments: [] } })
  );

  await page.goto('http://localhost:5173/');
  await page.getByRole('button', { name: 'Open plans.pdf' }).click();
  const dialog = page.getByRole('dialog', { name: 'plans.pdf' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('canvas[data-page="1"]')).toBeVisible();
  return dialog;
}

test('a PDF scrolls through its pages with the wheel, tracking the page shown', async ({ page }) => {
  const dialog = await openPdf(page);
  const pageStatus = dialog.getByRole('status', { name: 'Page' });
  const zoomStatus = dialog.getByRole('status', { name: 'Zoom' });
  await expect(pageStatus).toHaveText('1 / 3');
  const zoom = await zoomStatus.textContent();

  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20 && (await pageStatus.textContent()) === '1 / 3'; i++) {
    await page.mouse.wheel(0, 300);
  }
  await expect(pageStatus).not.toHaveText('1 / 3');
  // Scrolling doesn't zoom.
  await expect(zoomStatus).toHaveText(zoom!);
  await expect(dialog.locator('canvas[data-page="2"]')).toBeVisible();

  // Back up to the first page.
  for (let i = 0; i < 40 && (await pageStatus.textContent()) !== '1 / 3'; i++) {
    await page.mouse.wheel(0, -300);
  }
  await expect(pageStatus).toHaveText('1 / 3');
});

test('Ctrl + wheel zooms a PDF', async ({ page }) => {
  const dialog = await openPdf(page);
  const zoomStatus = dialog.getByRole('status', { name: 'Zoom' });
  const before = parseInt((await zoomStatus.textContent())!, 10);

  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');

  await expect.poll(async () => parseInt((await zoomStatus.textContent())!, 10)).toBeGreaterThan(before);
  await expect(dialog.getByRole('status', { name: 'Page' })).toHaveText('1 / 3');
});

test("the footer's ‹ and › scroll to the previous and next page", async ({ page }) => {
  const dialog = await openPdf(page);
  const pageStatus = dialog.getByRole('status', { name: 'Page' });

  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(pageStatus).toHaveText('2 / 3');
  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(pageStatus).toHaveText('3 / 3');
  await expect(dialog.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Previous page' }).click();
  await expect(pageStatus).toHaveText('2 / 3');
});
