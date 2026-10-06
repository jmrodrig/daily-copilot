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
  
  // click 'Notes-in' folder
  await page.click('text="Notes-in"').catch(e => console.log(e.message));
  await page.waitForTimeout(1000);
  
  // click 'A quick note demo'
  await page.click('text="A quick note demo"').catch(e => console.log(e.message));
  await page.waitForTimeout(2000);
  
  // look for a link and click it
  const links = await page.$$('.tiptap a');
  if (links.length > 0) {
    console.log('Clicking link...');
    await links[0].click();
    await page.waitForTimeout(1000);
  } else {
    console.log('No links found');
  }
  
  const inner = await page.evaluate(() => document.body.innerHTML);
  console.log('HTML length:', inner.length);
  if (inner.length < 500) console.log(inner);
  
  await browser.close();
})();
