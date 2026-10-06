import { test, expect, type Page } from "@playwright/test";

/**
 * Repro: "contentMatchAt on a node with invalid content" when the toolbar's Attach button uploads a PDF into a note
 * whose body is text followed by an image. Needs `npm run dev` on :5173; every note API the page touches is mocked,
 * so nothing is read from or saved to a real space.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function openNote(page: Page, content: string) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

  await page.route(/\/api\/notes\/file(\?|$)/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { path: "repro.md", frontmatter: { state: "draft" }, content } })
      : route.fulfill({ json: { path: "repro.md", frontmatter: { state: "draft" }, content } }),
  );
  await page.route(/\/api\/tasks(\?|$)/, (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/notes\/image$/, (route) => route.fulfill({ json: { url: "/files/document.pdf" } }));
  await page.route(/\/img\.png$/, (route) => route.fulfill({ body: PNG, contentType: "image/png" }));

  await page.goto("http://localhost:5173/note?space=1&path=repro.md");
  await page.getByRole("img", { name: "alt" }).waitFor();
  return errors;
}

/** The ProseMirror document and selection, read off the Tiptap editor the view's DOM carries. */
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as unknown as { editor?: any }).editor;
    if (!editor) return null;
    const sel = editor.state.selection;
    return { doc: editor.getJSON(), selection: { type: sel.constructor.name, json: sel.toJSON() }, destroyed: editor.isDestroyed };
  });

async function attachPdf(page: Page) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles({ name: "document.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") });
  // The upload finishes once the toolbar's status goes away.
  await expect(page.getByRole("status").filter({ hasText: "Uploading" })).toHaveCount(0);
  await page.waitForTimeout(300);
}

const CASES: { name: string; content: string; select: (page: Page) => Promise<void> }[] = [
  {
    name: "image selected (NodeSelection), text paragraph then image paragraph",
    content: "First paragraph\n\n![alt](/img.png)\n",
    select: (page) => page.getByRole("img", { name: "alt" }).click(),
  },
  {
    name: "image selected (NodeSelection), text and image in one paragraph",
    content: "First paragraph ![alt](/img.png)\n",
    select: (page) => page.getByRole("img", { name: "alt" }).click(),
  },
  {
    name: "caret at end of doc, after the image",
    content: "First paragraph\n\n![alt](/img.png)\n",
    select: async (page) => {
      await page.getByRole("img", { name: "alt" }).click();
      await page.keyboard.press("ArrowRight");
    },
  },
  {
    name: "editor never focused (toolbar clicked first)",
    content: "First paragraph\n\n![alt](/img.png)\n",
    select: async () => {},
  },
];

for (const c of CASES) {
  test(`attach PDF: ${c.name}`, async ({ page }) => {
    const errors = await openNote(page, c.content);
    await c.select(page);
    const before = await snapshot(page);
    await attachPdf(page);
    const after = await snapshot(page);

    console.log(`\n=== ${c.name}`);
    console.log("before:", JSON.stringify(before?.selection), JSON.stringify(before?.doc));
    console.log("after: ", JSON.stringify(after?.selection), JSON.stringify(after?.doc));
    console.log("errors:", errors);

    expect(errors.filter((e) => e.includes("contentMatchAt"))).toEqual([]);
    expect(JSON.stringify(after?.doc)).toContain("/files/document.pdf");
  });
}
