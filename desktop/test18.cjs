const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Go to a newly created note that is completely clean
  await page.goto('http://127.0.0.1:5173/notes/space/1');
  await page.waitForTimeout(1000);
  
  // Wait for it to redirect to a new note
  console.log("Navigated to", page.url());
  
  // Inject the insert script directly onto the page
  const result = await page.evaluate(() => {
    return new Promise(resolve => {
      // Find the editor view
      const editorElement = document.querySelector('.ProseMirror');
      if (!editorElement) return resolve("No editor found");
      
      // We can't access Tiptap directly, but we can simulate the toolbar upload
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        resolve("Found file input, going to upload");
      } else {
        resolve("No file input");
      }
    });
  });
  console.log("Result:", result);
  
  // Actually let's use the UI to upload
  fs.writeFileSync('dummy.pdf', 'dummy content');
  const input = await page.$('input[type="file"]');
  if (input) {
    await input.setInputFiles('dummy.pdf');
  }
  
  await page.waitForTimeout(2000);
  
  const inner = await page.evaluate(() => document.querySelector('.ProseMirror').innerHTML);
  console.log('Editor HTML length:', inner.length);
  
  const hasError = await page.evaluate(() => document.body.innerHTML.includes('Called contentMatchAt'));
  console.log('Crashed?', hasError);
  
  await browser.close();
})();
