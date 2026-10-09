import { test, expect, type Page, type Request } from "@playwright/test";

/**
 * The whiteboard: a `type: whiteboard` note's page, and a ```whiteboard block embedded in a note. Needs `npm run dev`
 * (on :5173, or BASE_URL); every API the page touches is mocked, so nothing is read from or saved to a real space.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A PDF of three pages, each a different shape: 200 × 100, 100 × 200 and 200 × 200 points. */
function threePagePdf(): Buffer {
  const sizes = [
    [200, 100],
    [100, 200],
    [200, 200],
  ];
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${sizes.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${sizes.length} >>`);
  sizes.forEach(([w, h], i) => {
    const stream = `0 0 1 rg 10 10 ${w - 20} ${h - 20} re f`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

type Board = {
  grid: boolean;
  elements: { id: string; kind: "image" | "pdf"; src: string; page?: number; x: number; y: number; w: number; h: number; z: number }[];
  markup: { strokes: { type: string; points: unknown[] }[]; comments: unknown[] };
};

const board = (b: Partial<Board> = {}): Board => ({ grid: true, elements: [], markup: { strokes: [], comments: [] }, ...b });

/** Open a note with the given front-matter and body; every save is recorded (and echoed back). */
async function openNote(page: Page, frontmatter: Record<string, unknown>, content: string) {
  const errors: string[] = [];
  const saves: Record<string, unknown>[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.route(/\/api\/notes\/file(\?|$)/, async (route) => {
    const request: Request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { path: "board.md", frontmatter, content } });
    const body = request.postDataJSON() as Record<string, unknown>;
    saves.push(body);
    return route.fulfill({ json: { path: "board.md", frontmatter, content: body.content ?? content } });
  });
  await page.route(/\/api\/tasks(\?|$)/, (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/notes\/image$/, (route) => route.fulfill({ json: { url: "/files/new.png" } }));
  await page.route(/\.png$/, (route) => route.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route(/\/files\/doc\.pdf$/, (route) => route.fulfill({ body: threePagePdf(), contentType: "application/pdf" }));

  await page.goto(`${BASE_URL}/note?space=1&path=board.md`);
  await page.locator("[data-whiteboard-stage]").first().waitFor();
  return { errors, saves };
}

/** The board last saved as a whiteboard note's body. */
const lastBoard = (saves: Record<string, unknown>[]) => JSON.parse(String(saves[saves.length - 1].content)) as Board;

async function stageBox(page: Page) {
  const box = await page.locator("[data-whiteboard-stage]").first().boundingBox();
  if (!box) throw new Error("no stage");
  return box;
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("a whiteboard note draws, saves, undoes and toggles its grid", async ({ page }) => {
  const { errors, saves } = await openNote(page, { state: "draft", type: "whiteboard" }, JSON.stringify(board()));
  await expect(page.getByRole("toolbar", { name: "Whiteboard tools" })).toBeVisible();
  // `type: whiteboard` shows as the page's layout and a tag, not as a property.
  await expect(page.getByText("whiteboard", { exact: true })).toBeVisible();

  const box = await stageBox(page);
  await drag(page, { x: box.x + 100, y: box.y + 100 }, { x: box.x + 300, y: box.y + 160 });
  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  expect(lastBoard(saves).markup.strokes).toHaveLength(1);

  // A rectangle, then Undo takes it away again.
  await page.getByRole("button", { name: /^Rectangle/ }).click();
  await drag(page, { x: box.x + 350, y: box.y + 100 }, { x: box.x + 450, y: box.y + 200 });
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Grid (G)" }).click();
  await expect.poll(() => saves.length && lastBoard(saves).grid, { timeout: 8000 }).toBe(false);
  expect(lastBoard(saves).markup.strokes).toHaveLength(1);
  await expect(page.locator("[data-whiteboard-stage]")).not.toHaveAttribute("style", /linear-gradient/);
  expect(errors).toEqual([]);
});

test("floating elements are picked, dragged, scaled, restacked and deleted", async ({ page }) => {
  const content = JSON.stringify(
    board({
      elements: [
        { id: "a", kind: "image", src: "/files/a.png", x: 0, y: 0, w: 200, h: 100, z: 0 },
        { id: "b", kind: "image", src: "/files/b.png", x: 300, y: 0, w: 100, h: 100, z: 1 },
      ],
    }),
  );
  const { errors, saves } = await openNote(page, { state: "draft", type: "whiteboard" }, content);
  await page.getByRole("button", { name: /^Select/ }).click();

  // The board's fitted at 100%, centered on its content (0..400 × 0..100): the world's origin is at the stage's
  // center less (200, 50).
  const box = await stageBox(page);
  const origin = { x: box.x + box.width / 2 - 200, y: box.y + box.height / 2 - 50 };
  const at = (x: number, y: number) => ({ x: origin.x + x, y: origin.y + y });

  // Click A: its toolbar shows. Drag it right by 20 and down by 30.
  await drag(page, at(100, 50), at(120, 80));
  await expect(page.getByRole("toolbar", { name: "Image" })).toBeVisible();
  await expect.poll(() => saves.length && lastBoard(saves).elements.find((e) => e.id === "a")?.x, { timeout: 8000 }).toBe(20);
  expect(lastBoard(saves).elements.find((e) => e.id === "a")?.y).toBe(30);

  // Scale it from its bottom-right corner (now at 220, 130): its shape is kept.
  await drag(page, at(220, 130), at(420, 230));
  await expect.poll(() => lastBoard(saves).elements.find((e) => e.id === "a")?.w, { timeout: 8000 }).toBeGreaterThan(300);
  const a = lastBoard(saves).elements.find((e) => e.id === "a")!;
  expect(a.w / a.h).toBeCloseTo(2, 1);
  expect([a.x, a.y]).toEqual([20, 30]);

  // A is behind B: bring it forward, then send it back.
  await page.getByRole("button", { name: "Bring forward" }).click();
  await expect.poll(() => lastBoard(saves).elements.find((e) => e.id === "a")?.z, { timeout: 8000 }).toBe(1);
  expect(lastBoard(saves).elements.find((e) => e.id === "b")?.z).toBe(0);
  await page.getByRole("button", { name: "Send to back" }).click();
  await expect.poll(() => lastBoard(saves).elements.find((e) => e.id === "a")?.z, { timeout: 8000 }).toBe(0);

  // Delete removes it.
  await page.keyboard.press("Delete");
  await expect.poll(() => lastBoard(saves).elements.map((e) => e.id), { timeout: 8000 }).toEqual(["b"]);
  expect(errors).toEqual([]);
});

test("images and PDFs are inserted, and a PDF's page set", async ({ page }) => {
  const content = JSON.stringify(board({ elements: [{ id: "p", kind: "pdf", src: "/files/doc.pdf", page: 0, x: 0, y: 0, w: 200, h: 100, z: 0 }] }));
  const { errors, saves } = await openNote(page, { state: "draft", type: "whiteboard" }, content);
  await expect(page.getByText("Loading PDF…")).toHaveCount(0, { timeout: 10_000 });

  await page.getByRole("button", { name: /^Select/ }).click();
  const box = await stageBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const toolbar = page.getByRole("toolbar", { name: "PDF" });
  await expect(toolbar).toContainText("/ 3");
  // Page 2 is tall: the element keeps its width and takes the page's shape.
  await toolbar.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => saves.length && lastBoard(saves).elements[0].page, { timeout: 8000 }).toBe(1);
  expect(lastBoard(saves).elements[0].w).toBe(200);
  expect(lastBoard(saves).elements[0].h).toBe(400);
  await toolbar.getByLabel("Set page").fill("3");
  await toolbar.getByLabel("Set page").press("Enter");
  await expect.poll(() => lastBoard(saves).elements[0].page, { timeout: 8000 }).toBe(2);
  expect(lastBoard(saves).elements[0].h).toBe(200);

  // Insert an image: it's uploaded, pinned on top, and picked.
  await page.locator('input[type="file"][accept*="image"]').setInputFiles({ name: "new.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("toolbar", { name: "Image" })).toBeVisible();
  await expect.poll(() => lastBoard(saves).elements.length, { timeout: 8000 }).toBe(2);
  const inserted = lastBoard(saves).elements.find((e) => e.kind === "image")!;
  expect(inserted.src).toBe("/files/new.png");
  expect(inserted.z).toBe(1);
  expect(errors).toEqual([]);
});

test("a whiteboard embedded in a note is edited in place and saved as a fenced block", async ({ page }) => {
  const content = `Before the board.\n\n\`\`\`whiteboard\n${JSON.stringify(board())}\n\`\`\`\n\nAfter the board.`;
  const { errors, saves } = await openNote(page, { state: "draft" }, content);
  await expect(page.locator(".ProseMirror")).toContainText("Before the board.");
  await expect(page.locator(".ProseMirror")).toContainText("After the board.");

  const box = await stageBox(page);
  await drag(page, { x: box.x + 80, y: box.y + 80 }, { x: box.x + 240, y: box.y + 140 });
  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  const saved = String(saves[saves.length - 1].content);
  const match = /```whiteboard\n(.*)\n```/.exec(saved);
  expect(match).not.toBeNull();
  expect((JSON.parse(match![1]) as Board).markup.strokes).toHaveLength(1);
  expect(saved).toContain("Before the board.");
  expect(saved).toContain("After the board.");

  // Fullscreen and back.
  await page.getByRole("button", { name: "Fullscreen" }).first().click();
  await expect(page.getByRole("dialog", { name: "Whiteboard" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Whiteboard" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a published note shows its embedded whiteboard read-only", async ({ page }) => {
  const stroke = { type: "line", color: "#ef4444", points: [{ x: 0, y: 0, width: 4 }, { x: 100, y: 50, width: 4 }] };
  const content = `Intro.\n\n\`\`\`whiteboard\n${JSON.stringify(board({ markup: { strokes: [stroke], comments: [] } }))}\n\`\`\``;
  const { errors } = await openNote(page, { state: "published" }, content);
  await expect(page.locator("[data-whiteboard-stage]")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Whiteboard tools" })).toHaveCount(0);
  await expect(page.locator("pre")).toHaveCount(0);
  expect(errors).toEqual([]);
});
