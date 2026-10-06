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
  await page.goto('http://127.0.0.1:5173');
  await page.waitForTimeout(2000);
  
  const inner = await page.evaluate(() => document.body.innerHTML);
  console.log("HTML length:", inner.length);
  if (inner.length < 200) console.log("HTML:", inner);
  
  await browser.close();
})();
