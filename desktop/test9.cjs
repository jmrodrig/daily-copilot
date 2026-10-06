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
  
  await page.goto('http://127.0.0.1:5173/notes/space/1/C7801');
  await page.waitForTimeout(2000);
  
  await page.locator('button[aria-label="New folder"]').click();
  await page.waitForTimeout(1000);
  
  await page.fill('input[placeholder="My new folder"]', 'TestRootFolder');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  
  const inner = await page.evaluate(() => document.body.innerHTML);
  console.log('HTML length after submitting:', inner.length);
  if (inner.length < 500) console.log(inner);
  
  await browser.close();
})();
