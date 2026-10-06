const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let crashed = false;
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('BROWSER ERROR CONSOLE:', msg.text());
    }
  });
  page.on('pageerror', err => {
    console.log('BROWSER PAGEERROR:', err.message);
    crashed = true;
  });
  
  await page.goto('http://127.0.0.1:5173/notes/space/1/C7801/Notes-in/Capture_20261002_224619.md');
  await page.waitForTimeout(2000);
  
  await page.locator('button[title="New folder"]').click();
  await page.waitForTimeout(1000);
  
  await page.fill('input[placeholder="My new folder"]', 'CrashTest');
  await page.press('input[placeholder="My new folder"]', 'Enter');
  await page.waitForTimeout(2000);
  
  const inner = await page.evaluate(() => document.body.innerHTML);
  if (inner.includes('React Error!')) {
    console.log('CRASHED! Found ErrorBoundary.');
  } else {
    console.log('Did not crash.');
  }
  
  await browser.close();
})();
