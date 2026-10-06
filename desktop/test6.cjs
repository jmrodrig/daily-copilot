const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('BROWSER ERROR CONSOLE:', msg.text());
    }
  });
  page.on('pageerror', err => console.log('BROWSER PAGEERROR:', err));
  
  await page.goto('http://127.0.0.1:5173/notes/space/1/C7801');
  await page.waitForTimeout(2000);
  
  // Look for the "New folder" button. Usually in the sidebar or similar.
  // Wait, let's just log all buttons to find it.
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent));
  console.log('Buttons:', buttons);
  
  await browser.close();
})();
