const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('http://127.0.0.1:5173/notes/space/1/C7801');
  await page.waitForTimeout(2000);
  
  // Create a dummy file
  fs.writeFileSync('dummy.pdf', 'dummy content');
  
  // Find the attach button (Toolbar button for attachment usually has an SVG or specific aria-label)
  // Wait, I didn't give it an aria-label!
  // It's in the Toolbar component: <button onClick={() => fileInputRef.current?.click()} ...>
  // Let's just set the file input directly
  const input = await page.$('input[type="file"]');
  if (input) {
    await input.setInputFiles('dummy.pdf');
  } else {
    console.log('No file input found');
  }
  
  await page.waitForTimeout(2000);
  
  const inner = await page.evaluate(() => document.querySelector('.ProseMirror').innerHTML);
  console.log('Editor HTML:', inner);
  
  await browser.close();
})();
