const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('http://127.0.0.1:5173/notes/space/1/C7801');
  await page.waitForTimeout(2000);
  
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.ProseMirror a')).map(a => a.getAttribute('href'));
  });
  console.log('Hrefs in editor:', hrefs);
  
  await browser.close();
})();
