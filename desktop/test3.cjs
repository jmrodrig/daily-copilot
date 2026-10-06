const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
  await page.goto('http://127.0.0.1:5173');
  await page.waitForTimeout(2000);
  
  try {
    await page.click('text="A quick note demo"');
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log("Could not click note:", e.message);
  }

  await browser.close();
})();
