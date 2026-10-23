import {
  Extension,
  Mark,
  Node,
  decodeHtmlEntities,
  encodeHtmlEntities,
  type JSONContent,
  type MarkdownRendererHelpers,
  type MarkdownToken,
} from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import { Table, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextStyle } from "@tiptap/extension-text-style";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Element, Root } from "hast";
import katex from "katex";
import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

import { isLocalHref } from "../lib/localFiles";

/**
 * Text color and alignment for notes. Markdown has no syntax for either, so they're saved as inline HTML the
 * read-only view renders too (with `rehype-raw`, sanitized by `NOTE_HTML_SCHEMA`):
 *
 *   <span style="color: #e5484d">red **text**</span>
 *
 *   <div style="text-align: center">
 *
 *   ## A centered heading
 *
 *   </div>
 *
 * The blank lines keep the wrapped block (and the span's content) markdown, so other formatting survives inside it.
 * Both shapes are read back by custom tokenizers rather than as HTML, which would take the inner markdown literally.
 *
 * Table cell colors keep the GFM table: a colored cell's content is wrapped in a background-colored span,
 *
 *   | <span style="background-color: #ef646140">**late**</span> | on time |
 *
 * which the editor reads back onto the cell (`ColoredTable`) and the read-only view lifts onto the `<td>`
 * (`liftCellColors`), so the whole cell is tinted. Other markdown renderers just highlight the text.
 *
 * Images fill the text column, centered, as plain `![alt](url)`. One resized is saved as an `<img>` with its width
 * as a percentage of the column, centered the same way:
 *
 *   <img src="/api/notes/image/1/shot.png" alt="" width="50%" style="display: block; margin: 0 auto" />
 *
 * A resized table keeps the GFM table, wrapped in a div with its width (the blank lines keep the table markdown):
 *
 *   <div style="width: 150%">
 *
 *   | a | b |
 *   | - | - |
 *
 *   </div>
 *
 * Widths over 100% break out of the text column, up to the page's full width: `FULL_WIDTH` is wider than any page,
 * so it always fills it. Both views lay them out with the `note-media` class (see index.css and `layoutMedia`).
 *
 * A whiteboard embedded in a note is a fenced block of its JSON (see whiteboard.ts), on one line:
 *
 *   ```whiteboard
 *   {"grid": true, "elements": [], "markup": {"strokes": [], "comments": []}}
 *   ```
 *
 * which the editor shows as a live board (`WhiteboardBlock`) and the read-only view as a read-only one; other
 * markdown renderers show the JSON as code. A voice recording's listen widget is a ```listen block the same way
 * (`ListenBlock`), and so is a spreadsheet, a ```spreadsheet block (`SpreadsheetBlock`).
 */

/** The text column a note's title, properties and body sit in, centered on the page (see `.note-body` in index.css). */
export const NOTE_COLUMN = "mx-auto w-full max-w-4xl print:max-w-none";

export const ALIGNMENTS = ["left", "center", "right"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

/** Hex colors, as the picker gives them, or the rgb() ones the browser turns pasted styles into. */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
const SPAN = /^<span style="color: ?([^";<>]+?);?">([\s\S]*?)<\/span>/;
const CELL_SPAN_OPEN = /^<span style="background-color: ?([^";<>]+?);?">$/;
const ALIGNED_BLOCK = /^<div style="text-align: ?(left|center|right);?">\n+([\s\S]*?)\n+<\/div>(?:\n+|$)/;

/** The text-style mark (which carries `Color`), saved as a colored `<span>`. */
export const ColoredTextStyle = TextStyle.extend({
  markdownTokenName: "coloredSpan",
  markdownTokenizer: {
    name: "coloredSpan",
    level: "inline",
    start: (src: string) => src.indexOf("<span style="),
    tokenize(src, _tokens, lexer) {
      const match = SPAN.exec(src);
      if (!match || !COLOR.test(match[1])) return undefined;
      return { type: "coloredSpan", raw: match[0], color: match[1], tokens: lexer.inlineTokens(match[2]) };
    },
  },
  parseMarkdown: (token, h) => h.applyMark("textStyle", h.parseInline(token.tokens ?? []), { color: token.color }),
  renderMarkdown: (node, h) => {
    const color = node.attrs?.color;
    const content = h.renderChildren(node);
    return typeof color === "string" && COLOR.test(color) ? `<span style="color: ${color}">${content}</span>` : content;
  },
});

/**
 * Wrap a paragraph's or heading's markdown in a `text-align` div, unless it's left-aligned (the default). Only
 * top-level blocks are: list items and table rows don't nest the wrapper (the toolbar only aligns those).
 */
function aligned(node: JSONContent, markdown: string, parentType?: string | null): string {
  const align = node.attrs?.textAlign;
  if (parentType !== "doc" || !markdown.trim() || align === "left" || !ALIGNMENTS.includes(align)) return markdown;
  return `<div style="text-align: ${align}">\n\n${markdown}\n\n</div>`;
}

export const AlignedParagraph = Paragraph.extend({
  renderMarkdown(node, h, ctx) {
    return aligned(node, this.parent?.(node, h, ctx) ?? "", ctx.parentType);
  },
  parseMarkdown(token, h) {
    // Tiptap unwraps a paragraph of nothing but an image into the image itself, a block; ours is inline (as
    // `![]()` is), so it would sit loose in the doc, which the schema doesn't allow. Keep its paragraph.
    const tokens = token.tokens ?? [];
    if (tokens.length === 1 && tokens[0].type === "image") return h.createNode("paragraph", null, h.parseInline(tokens));
    return this.parent?.(token, h) ?? [];
  },
});

export const AlignedHeading = Heading.extend({
  renderMarkdown(node, h, ctx) {
    return aligned(node, this.parent?.(node, h, ctx) ?? "", ctx.parentType);
  },
});

/** Reads the `text-align` divs back, aligning the paragraphs and headings inside. */
export const AlignedBlocks = Extension.create({
  name: "alignedBlocks",
  markdownTokenName: "alignedBlock",
  markdownTokenizer: {
    name: "alignedBlock",
    level: "block",
    start: (src: string) => src.indexOf("<div style="),
    tokenize(src, _tokens, lexer) {
      const match = ALIGNED_BLOCK.exec(src);
      if (!match) return undefined;
      return { type: "alignedBlock", raw: match[0], align: match[1], tokens: lexer.blockTokens(match[2]) };
    },
  },
  parseMarkdown: (token, h) =>
    h
      .parseChildren(token.tokens ?? [])
      .map((node) =>
        node.type === "paragraph" || node.type === "heading" ? { ...node, attrs: { ...node.attrs, textAlign: token.align } } : node,
      ),
});

/** A table cell's tint, kept in its `style` like the text color. */
const backgroundColor = {
  backgroundColor: {
    default: null,
    parseHTML: (element: HTMLElement) => (COLOR.test(element.style.backgroundColor) ? element.style.backgroundColor : null),
    renderHTML: (attrs: Record<string, unknown>) =>
      typeof attrs.backgroundColor === "string" && COLOR.test(attrs.backgroundColor)
        ? { style: `background-color: ${attrs.backgroundColor}` }
        : {},
  },
};

export const ColoredTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundColor };
  },
});

export const ColoredTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundColor };
  },
});

/** The layout columns, in percent of the text column, an image or table snaps to when resized; 100 is the default. */
export const MEDIA_WIDTHS = [25, 50, 75, 100, 125, 150, 200] as const;
/** The page's full width: wider than any page, and clamped to it when laid out. */
export const FULL_WIDTH = 400;

/** A width in percent other than the column's (a whole 1–`FULL_WIDTH`), or `null`: the column's width. */
export function mediaWidth(value: unknown): number | null {
  const width = Number(value);
  return Number.isInteger(width) && width >= 1 && width <= FULL_WIDTH && width !== 100 ? width : null;
}

/**
 * The widths a resize snaps to on a page `canvas` pixels wide, with a text column `column` pixels wide: the columns
 * of `MEDIA_WIDTHS` that fit, then the full width if the page is any wider than the column.
 */
export function snapWidths(column: number, canvas: number): number[] {
  const max = (canvas / column) * 100;
  const widths: number[] = MEDIA_WIDTHS.filter((w) => w <= 100 || w < max - 5);
  return max > 105 ? [...widths, FULL_WIDTH] : widths;
}

/** The snap width nearest a dragged one, both in percent of a column of which the page is `max` percent. */
export function nearestWidth(percent: number, widths: number[], max: number): number {
  const distance = (w: number) => Math.abs(Math.min(w, max) - percent);
  return widths.reduce((best, w) => (distance(w) < distance(best) ? w : best), 100);
}

/** Where a snap width's guide lines sit, from the left of the column; the full width's are at the page's edges. */
export function guideOffsets(width: number): [string, string] {
  return width === FULL_WIDTH ? ["calc(50% - 50cqw)", "calc(50% + 50cqw)"] : [`${(100 - width) / 2}%`, `${(100 + width) / 2}%`];
}

export const widthLabel = (width: number) => (width === FULL_WIDTH ? "Full width" : `${width}%`);

/** The `note-media` box's width, as a scale of its column (see index.css). */
export const mediaStyle = (width: number) => `--media-scale: ${width / 100}`;

const SIZED_TABLE = /^<div style="width: ?(\d{1,3})%;?">\n+([\s\S]*?)\n+<\/div>(?:\n+|$)/;

/** Reads a resized table's width div back (see the top) onto the table inside. */
const SizedTableBlocks = Extension.create({
  name: "sizedTableBlocks",
  markdownTokenName: "sizedTable",
  markdownTokenizer: {
    name: "sizedTable",
    level: "block",
    start: (src: string) => src.indexOf("<div style="),
    tokenize(src, _tokens, lexer) {
      const match = SIZED_TABLE.exec(src);
      const width = match && mediaWidth(match[1]);
      if (!match || !width) return undefined;
      return { type: "sizedTable", raw: match[0], width, tokens: lexer.blockTokens(match[2]) };
    },
  },
  parseMarkdown: (token, h) =>
    h
      .parseChildren(token.tokens ?? [])
      .map((node) => (node.type === "table" ? { ...node, attrs: { ...node.attrs, width: token.width } } : node)),
});

type CellToken = { tokens?: MarkdownToken[]; align?: unknown; color?: string };
type TableToken = MarkdownToken & { header?: CellToken[]; rows?: CellToken[][] };

/**
 * A table whose cells keep their color in markdown, wrapped in a background-colored span, and with a `width` (a
 * percentage of the text column, `null` for the column's), saved as a width div (see the top). Its resize handle is
 * a node view, added by the editor.
 */
export const ColoredTable = Table.extend({
  addExtensions() {
    return [SizedTableBlocks];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => mediaWidth(element.getAttribute("data-width")),
        renderHTML: (attrs: Record<string, unknown>) => {
          const width = mediaWidth(attrs.width);
          return width ? { "data-width": String(width) } : {};
        },
      },
    };
  },
  renderMarkdown(node, h, ctx) {
    // The GFM renderer renders each cell's content through `renderChildren`: all of it at once or, for several
    // paragraphs (joined with <br>), one at a time. The span goes around what it renders for a colored cell.
    const wraps = new Map<unknown, { open: string; close: string }>();
    for (const row of node.content ?? []) {
      for (const cell of row.content ?? []) {
        const color = cell.attrs?.backgroundColor;
        const content = cell.content ?? [];
        if (typeof color !== "string" || !COLOR.test(color) || !content.length) continue;
        const open = `<span style="background-color: ${color}">`;
        if (content.length === 1) {
          wraps.set(content, { open, close: "</span>" });
        } else {
          wraps.set(content[0], { open, close: "" });
          wraps.set(content[content.length - 1], { open: "", close: "</span>" });
        }
      }
    }
    const helpers: MarkdownRendererHelpers = {
      ...h,
      renderChildren: (nodes, separator) => {
        const markdown = h.renderChildren(nodes, separator);
        const wrap = wraps.get(nodes);
        return wrap ? `${wrap.open}${markdown}${wrap.close}` : markdown;
      },
    };
    const markdown = this.parent?.(node, helpers, ctx) ?? "";
    const width = mediaWidth(node.attrs?.width);
    return width ? `<div style="width: ${width}%">\n\n${markdown.trim()}\n\n</div>` : markdown;
  },
  parseMarkdown(token, h) {
    // A colored cell lexes as an opening and a closing html tag around its content: unwrap it, then color the cells
    // the GFM parser builds, which come out in the same order.
    const table = token as TableToken;
    const unwrap = (cell: CellToken): CellToken => {
      const tokens = cell.tokens ?? [];
      const open = tokens[0]?.type === "html" ? CELL_SPAN_OPEN.exec(tokens[0].raw ?? "") : null;
      const close = tokens[tokens.length - 1];
      if (!open || !COLOR.test(open[1]) || tokens.length < 2 || close.type !== "html" || close.raw?.trim() !== "</span>") {
        return cell;
      }
      return { ...cell, tokens: tokens.slice(1, -1), color: open[1] };
    };
    const header = table.header?.map(unwrap);
    const rows = table.rows?.map((row) => row.map(unwrap));
    const colors = [...(header ?? []), ...(rows ?? []).flat()].map((cell) => cell.color);
    const parsed = this.parent?.({ ...table, header, rows }, h);
    if (!parsed || Array.isArray(parsed)) return parsed ?? [];
    let i = 0;
    for (const row of parsed.content ?? []) {
      for (const cell of row.content ?? []) {
        const color = colors[i++];
        if (color) cell.attrs = { ...cell.attrs, backgroundColor: color };
      }
    }
    return parsed;
  },
});

/**
 * A rehype plugin for the read-only view: a table cell holding nothing but a background-colored span (as saved
 * above) takes the span's color itself, tinting the whole cell rather than just its text. It runs after the
 * sanitizer, so the colors are ones it let through.
 */
export function liftCellColors() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "td" || child.tagName === "th") liftCellColor(child);
        visit(child);
      }
    };
    visit(tree);
  };
}

function liftCellColor(cell: Element) {
  const content = cell.children.filter((c) => !(c.type === "text" && !c.value.trim()));
  const span = content[0];
  if (content.length !== 1 || span.type !== "element" || span.tagName !== "span") return;
  const match = /^background-color: ?([^;]+);?$/.exec(String(span.properties.style ?? ""));
  if (!match || !COLOR.test(match[1])) return;
  cell.properties = { ...cell.properties, style: `background-color: ${match[1]}` };
  cell.children = span.children;
}

const IMAGE_STYLE = "display: block; margin: 0 auto";
const IMAGE_WIDTH = /^(\d{1,3})%$/;
const SIZED_IMAGE = /^<img src="([^"<>]*)" alt="([^"<>]*)"(?: title="([^"<>]*)")? width="(\d{1,3})%" style="display: block; margin: 0 auto" ?\/?>/;
/** One or more resized images alone on a line, which markdown would take for a block of raw HTML. */
const IMAGES_LINE = String.raw`(?:${SIZED_IMAGE.source.slice(1)}[ \t]*)+`;
const SIZED_IMAGE_LINE = new RegExp(String.raw`^${IMAGES_LINE}(?:\n+|$)`);
const ANY_SIZED_IMAGE_LINE = new RegExp(String.raw`^${IMAGES_LINE}$`, "m");

const attribute = (value: unknown) => encodeHtmlEntities(String(value ?? "")).replace(/"/g, "&quot;");

/** Reads a resized image's `<img>` tag back (see the top) within a line of text. */
const SizedImageTags = Extension.create({
  name: "sizedImageTags",
  markdownTokenName: "sizedImage",
  markdownTokenizer: {
    name: "sizedImage",
    level: "inline",
    start: (src: string) => src.indexOf("<img src="),
    tokenize(src) {
      const match = SIZED_IMAGE.exec(src);
      const width = match && mediaWidth(match[4]);
      if (!match || !width) return undefined;
      const [href, text, title] = match.slice(1, 4).map((value) => (value === undefined ? undefined : decodeHtmlEntities(value)));
      return { type: "sizedImage", raw: match[0], href, text, title, width };
    },
  },
  parseMarkdown: (token, h) =>
    h.createNode("image", { src: token.href, alt: token.text || null, title: token.title || null, width: token.width }),
});

/** Reads back a line of nothing but resized images as the paragraph holding them (they're inline, as `![]()` is). */
const SizedImageLines = Extension.create({
  name: "sizedImageLines",
  markdownTokenName: "sizedImageLine",
  markdownTokenizer: {
    name: "sizedImageLine",
    level: "block",
    // Only such a line ends the paragraph before it: an image within a line of text is the inline tokenizer's.
    start: (src: string) => src.search(ANY_SIZED_IMAGE_LINE),
    tokenize(src, _tokens, lexer) {
      const match = SIZED_IMAGE_LINE.exec(src);
      if (!match) return undefined;
      return { type: "sizedImageLine", raw: match[0], tokens: lexer.inlineTokens(match[0].trim()) };
    },
  },
  parseMarkdown: (token, h) => h.createNode("paragraph", null, h.parseInline(token.tokens ?? [])),
});

/**
 * The image node with a `width` (a percentage of the text column, `null` for the column's), saved as an `<img>` tag
 * when it's resized (see the top). Its resize handles are a node view, added by the editor.
 */
export const SizedImage = Image.extend({
  addExtensions() {
    return [SizedImageTags, SizedImageLines];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => mediaWidth(IMAGE_WIDTH.exec(element.getAttribute("width") ?? "")?.[1]),
        renderHTML: (attrs: Record<string, unknown>) => {
          const width = mediaWidth(attrs.width);
          return width ? { width: `${width}%`, style: IMAGE_STYLE } : {};
        },
      },
      height: { default: null, rendered: false },
    };
  },
  renderMarkdown(node, h, ctx) {
    const width = mediaWidth(node.attrs?.width);
    if (!width) return this.parent?.(node, h, ctx) ?? "";
    const { src, alt, title } = node.attrs ?? {};
    return `<img src="${attribute(src)}" alt="${attribute(alt)}"${title ? ` title="${attribute(title)}"` : ""} width="${width}%" style="${IMAGE_STYLE}" />`;
  },
});

const CSS_COLOR = String.raw`(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))`;
const CELL_STYLE = new RegExp(`^background-color: ?${CSS_COLOR};?$`, "i");
const WIDTH_STYLE = /^width: ?(\d{1,3})%;?$/;

// A Windows drive path (`O:\Files`) reads to the sanitizer as a URL with protocol `O`: allow every drive letter, and
// `file:`, so links to local files keep their href (see isLocalHref).
const DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)).flatMap((c) => [c, c.toUpperCase()]);

/**
 * The sanitizer schema for rendering notes: GitHub's defaults, plus the colors, alignment and width divs and image
 * sizes above, and links to local files and folders.
 */
export const NOTE_HTML_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "file", ...DRIVE_LETTERS] },
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["style", new RegExp(`^(background-)?color: ?${CSS_COLOR};?$`, "i")]],
    div: [...(defaultSchema.attributes?.div ?? []), ["style", /^(text-align: ?(left|center|right)|width: ?\d{1,3}%);?$/]],
    td: [...(defaultSchema.attributes?.td ?? []), ["style", CELL_STYLE]],
    th: [...(defaultSchema.attributes?.th ?? []), ["style", CELL_STYLE]],
    img: [...(defaultSchema.attributes?.img ?? []), ["width", IMAGE_WIDTH], ["style", IMAGE_STYLE]],
  },
};

/**
 * A rehype plugin for the read-only view, laying resized images and tables out as the editor does (see index.css): a
 * resized image takes the `note-media` class at its width, and a table's width div becomes a column-wide
 * `note-table` holding a `note-media` box at its width. It runs after the sanitizer, so the widths are ones it let
 * through.
 */
export function layoutMedia() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      node.children.forEach((child, i) => {
        if (child.type !== "element") return;
        if (child.tagName === "img") {
          const width = mediaWidth(IMAGE_WIDTH.exec(String(child.properties.width ?? ""))?.[1]);
          if (width) child.properties = { ...child.properties, width: undefined, className: ["note-media"], style: mediaStyle(width) };
        } else if (child.tagName === "div") {
          const width = mediaWidth(WIDTH_STYLE.exec(String(child.properties.style ?? ""))?.[1]);
          if (width) {
            const media: Element = { type: "element", tagName: "div", properties: { className: ["note-media"], style: mediaStyle(width) }, children: child.children };
            node.children[i] = { type: "element", tagName: "div", properties: { className: ["note-table"] }, children: [media] };
            visit(media);
            return;
          }
        }
        visit(child);
      });
    };
    visit(tree);
  };
}

/** An empty embedded whiteboard's JSON. */
export const EMPTY_WHITEBOARD_JSON = '{"grid":true,"elements":[],"markup":{"strokes":[],"comments":[]}}';

const WHITEBOARD_FENCE = /^ {0,3}```whiteboard[ \t]*\n([\s\S]*?)\n? {0,3}```[ \t]*(?:\n+|$)/;

/**
 * An embedded whiteboard (see the top): a block atom holding the board's JSON in `data`, read from and saved as a
 * ```whiteboard fenced block. It's read by its own tokenizer, before the code block's, so it's never taken for code.
 * The live board is a node view, added by the editor (see WhiteboardWidget).
 */
export const WhiteboardBlock = Node.create({
  name: "whiteboard",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      data: {
        default: EMPTY_WHITEBOARD_JSON,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-whiteboard") ?? EMPTY_WHITEBOARD_JSON,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-whiteboard": String(attrs.data ?? EMPTY_WHITEBOARD_JSON) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-whiteboard]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes];
  },
  markdownTokenName: "whiteboard",
  markdownTokenizer: {
    name: "whiteboard",
    level: "block",
    start: (src: string) => src.indexOf("```whiteboard"),
    tokenize(src) {
      const match = WHITEBOARD_FENCE.exec(src);
      if (!match) return undefined;
      return { type: "whiteboard", raw: match[0], text: match[1].trim() };
    },
  },
  parseMarkdown: (token, h) => h.createNode("whiteboard", { data: (token.text as string | undefined) || EMPTY_WHITEBOARD_JSON }),
  renderMarkdown: (node) => {
    // On one line, with no backtick in it, so it can't end its fence early (see whiteboard.ts).
    const data = String(node.attrs?.data ?? EMPTY_WHITEBOARD_JSON).replace(/\r?\n/g, " ").replace(/`/g, "\\u0060");
    return "```whiteboard\n" + data + "\n```";
  },
});

/** An empty embedded spreadsheet's JSON: one 5 × 5 sheet (see spreadsheet.ts). */
export const EMPTY_SPREADSHEET_JSON = JSON.stringify({
  activeSheet: "Sheet1",
  sheets: [{ name: "Sheet1", rows: Array.from({ length: 5 }, () => Array<string>(5).fill("")) }],
});

/** A spreadsheet window not yet pointed at a workbook file: it offers to pick one (see SpreadsheetWidget). */
export const EMPTY_SPREADSHEET_WINDOW_JSON = "{}";

const SPREADSHEET_FENCE = /^ {0,3}```spreadsheet[ \t]*\n([\s\S]*?)\n? {0,3}```[ \t]*(?:\n+|$)/;

/**
 * A spreadsheet in the note: a block atom holding its JSON in `data`, read from and saved as a ```spreadsheet fenced
 * block on one line, as a whiteboard is. Either a window onto a workbook file attached to the note, showing some of
 * its cells (see SpreadsheetWidget), or, as notes saved them before, a whole spreadsheet embedded (see spreadsheet.ts):
 *
 *   ```spreadsheet
 *   {"src":"/api/notes/image/<name>.xlsx?space_id=1","sheet":"Costs","displayArea":"A1:E8","title":"Budget.xlsx"}
 *   ```
 *
 *   ```spreadsheet
 *   {"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","rows":[["Item","Cost"],["Keel","=B3*2"]]}]}
 *   ```
 *
 * The grid is a node view, added by the editor (see SpreadsheetWidget).
 */
export const SpreadsheetBlock = Node.create({
  name: "spreadsheet",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      data: {
        default: EMPTY_SPREADSHEET_JSON,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-spreadsheet") ?? EMPTY_SPREADSHEET_JSON,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-spreadsheet": String(attrs.data ?? EMPTY_SPREADSHEET_JSON) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-spreadsheet]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes];
  },
  markdownTokenName: "spreadsheet",
  markdownTokenizer: {
    name: "spreadsheet",
    level: "block",
    start: (src: string) => src.indexOf("```spreadsheet"),
    tokenize(src) {
      const match = SPREADSHEET_FENCE.exec(src);
      if (!match) return undefined;
      return { type: "spreadsheet", raw: match[0], text: match[1].trim() };
    },
  },
  parseMarkdown: (token, h) => h.createNode("spreadsheet", { data: (token.text as string | undefined) || EMPTY_SPREADSHEET_JSON }),
  renderMarkdown: (node) => {
    // On one line, with no backtick in it, so it can't end its fence early. A cell's line break is `\n` in the JSON
    // already; a raw one is only JSON's whitespace.
    const data = String(node.attrs?.data ?? EMPTY_SPREADSHEET_JSON).replace(/\r?\n/g, " ").replace(/`/g, "\\u0060");
    return "```spreadsheet\n" + data + "\n```";
  },
});

/** A new listen widget's JSON: its own id (which the backend writes the transcript back by), not yet recorded. */
export function newListenJson(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const id = `lw_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return JSON.stringify({ id, status: "idle", source: "mic" });
}

const EMPTY_LISTEN_JSON = '{"id":"","status":"idle"}';
const LISTEN_FENCE = /^ {0,3}```listen[ \t]*\n([\s\S]*?)\n? {0,3}```[ \t]*(?:\n+|$)/;

/**
 * A listen widget (see ListenWidget): a block atom holding its JSON in `data` (its id, and once recorded, the
 * transcript, the speakers and the recording's file), read from and saved as a ```listen fenced block on one line,
 * as a whiteboard is:
 *
 *   ```listen
 *   {"id":"lw_3f9a…","status":"completed","duration":48.5,"audio_file":"voice_20261018_130000.wav","dialogue":"…","participants":[…]}
 *   ```
 *
 * The backend writes into the block too (backend/voice.py), by its id. The widget is a node view, added by the editor.
 */
export const ListenBlock = Node.create({
  name: "listen",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      data: {
        default: EMPTY_LISTEN_JSON,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-listen") ?? EMPTY_LISTEN_JSON,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-listen": String(attrs.data ?? EMPTY_LISTEN_JSON) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-listen]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes];
  },
  markdownTokenName: "listen",
  markdownTokenizer: {
    name: "listen",
    level: "block",
    start: (src: string) => src.indexOf("```listen"),
    tokenize(src) {
      const match = LISTEN_FENCE.exec(src);
      if (!match) return undefined;
      return { type: "listen", raw: match[0], text: match[1].trim() };
    },
  },
  parseMarkdown: (token, h) => h.createNode("listen", { data: (token.text as string | undefined) || EMPTY_LISTEN_JSON }),
  renderMarkdown: (node) => {
    // On one line, with no backtick in it, so it can't end its fence early.
    const data = String(node.attrs?.data ?? EMPTY_LISTEN_JSON).replace(/\r?\n/g, " ").replace(/`/g, "\\u0060");
    return "```listen\n" + data + "\n```";
  },
});

/**
 * Math, as the read-only view renders it (remark-math and KaTeX): `$…$` inline, and `$$…$$` on lines of its own.
 *
 *   - **Lightship Displacement ($M_L$):** 6,500 kg
 *
 *   $$
 *   RM = \Delta \cdot GZ
 *   $$
 *
 * Inline math is a mark rather than a node, so the marks around it stay open when it's saved: a node in a bold run
 * closes the bold before it and reopens it after (`**Lightship (**$M_L$**):**`). As a `code` mark its LaTeX is saved
 * unescaped, and with a lower priority than bold or italic it nests inside them. The editor shows it rendered, and
 * its LaTeX while the caret is in it (`mathPreview`).
 */

// No space just inside the dollars, and no digit just after the closing one, so prices ("$5 and $10") stay text.
const INLINE_MATH = /^(\${1,2})(?![\s$])([^$\n]*?[^\s$\\])\1(?!\d)/;
const BLOCK_MATH = /^ {0,3}\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/;
const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';

/** The LaTeX a KaTeX rendering was made from, kept in its MathML. */
const texOf = (element: ParentNode) => element.querySelector(TEX_ANNOTATION)?.textContent?.trim() ?? "";

const mathPreviewKey = new PluginKey<boolean>("mathPreview");

/** The runs of text with a mark (the inline math mark: its LaTeX), and the text each holds. */
function markRanges(doc: ProseMirrorNode, markName: string) {
  const ranges: { from: number; to: number; text: string }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.marks.some((mark) => mark.type.name === markName)) return;
    const last = ranges[ranges.length - 1];
    if (last && last.to === pos) {
      last.to += node.nodeSize;
      last.text += node.text ?? "";
    } else {
      ranges.push({ from: pos, to: pos + node.nodeSize, text: node.text ?? "" });
    }
  });
  return ranges;
}

/**
 * Shows each run of inline math rendered, with its LaTeX hidden, unless the caret is in it (and the editor focused):
 * then the LaTeX is shown to edit. Clicking the rendered math puts the caret in it.
 */
function mathPreview(markName: string) {
  return new Plugin<boolean>({
    key: mathPreviewKey,
    state: {
      init: () => false,
      apply: (tr, focused) => (tr.getMeta(mathPreviewKey) as boolean | undefined) ?? focused,
    },
    props: {
      decorations(state) {
        const focused = mathPreviewKey.getState(state);
        const { from: selFrom, to: selTo } = state.selection;
        const decorations: Decoration[] = [];
        for (const { from, to, text: latex } of markRanges(state.doc, markName)) {
          if (focused && selFrom >= from && selTo <= to) continue;
          const widget = Decoration.widget(
            from,
            (view, getPos) => {
              const dom = document.createElement("span");
              dom.className = "note-math-inline-widget";
              dom.contentEditable = "false";
              dom.innerHTML = katex.renderToString(latex, { throwOnError: false, output: "html" });
              dom.addEventListener("mousedown", (event) => {
                event.preventDefault();
                const pos = getPos();
                if (pos === undefined || !view.editable) return;
                view.focus();
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + latex.length)));
              });
              return dom;
            },
            { key: `math:${latex}`, side: -1, ignoreSelection: true, stopEvent: () => true },
          );
          decorations.push(widget, Decoration.inline(from, to, { class: "note-math-source-hidden" }));
        }
        return DecorationSet.create(state.doc, decorations);
      },
      handleDOMEvents: {
        focus: (view) => {
          if (!mathPreviewKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(mathPreviewKey, true));
          return false;
        },
        blur: (view) => {
          if (mathPreviewKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(mathPreviewKey, false));
          return false;
        },
      },
    },
  });
}

/** Inline math (see above): a mark over its LaTeX, saved as `$…$`. */
export const InlineMath = Mark.create({
  name: "inlineMath",
  priority: 50,
  code: true,
  excludes: "code",
  inclusive: false,
  parseHTML() {
    return [{ tag: "span[data-math-inline]" }];
  },
  renderHTML() {
    return ["span", { class: "note-math-inline", "data-math-inline": "" }, 0];
  },
  markdownTokenName: "inlineMath",
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    // Not an escaped `\$`, which stays a dollar sign.
    start: (src: string) => src.search(/(?<!\\)\$/),
    tokenize(src) {
      const match = INLINE_MATH.exec(src);
      if (!match) return undefined;
      return { type: "inlineMath", raw: match[0], text: match[2] };
    },
  },
  parseMarkdown: (token, h) => h.applyMark("inlineMath", [h.createTextNode(String(token.text ?? ""))]),
  renderMarkdown: (node, h) => `$${h.renderChildren(node)}$`,
  addProseMirrorPlugins() {
    return [mathPreview(this.name)];
  },
});

export type LocalPathRange = { from: number; to: number; path: string; label: string | null };

/**
 * Inline code holding a local file or folder's path (`\\server\share\…`, `C:\…`), as the chat cites files, and links
 * to one: each run with its path and, for a link whose text isn't the path itself, that text (`label`), in document
 * order. NoteEditor turns those found on disk into pills (see referencePill).
 */
export function localPathRanges(doc: ProseMirrorNode): LocalPathRange[] {
  const ranges: LocalPathRange[] = markRanges(doc, "code").flatMap(({ from, to, text }) =>
    isLocalHref(text.trim()) ? [{ from, to, path: text.trim(), label: null }] : [],
  );
  const links: (LocalPathRange & { text: string })[] = [];
  doc.descendants((node, pos) => {
    const href = node.isText ? (node.marks.find((mark) => mark.type.name === "link")?.attrs.href as string | undefined) : undefined;
    if (!isLocalHref(href)) return;
    const last = links[links.length - 1];
    if (last && last.to === pos && last.path === href) {
      last.to += node.nodeSize;
      last.text += node.text ?? "";
    } else {
      links.push({ from: pos, to: pos + node.nodeSize, path: href, label: null, text: node.text ?? "" });
    }
  });
  for (const { text, ...link } of links) {
    // Code inside a link is taken as the code's path.
    if (ranges.some((r) => r.from < link.to && link.from < r.to)) continue;
    const label = text.trim();
    ranges.push({ ...link, label: label && label !== link.path ? label : null });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/** Display math (see above): a block atom holding its LaTeX, saved as `$$…$$` on lines of its own. */
export const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-math-block") || texOf(element),
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-math-block]" }, { tag: "span.katex-display" }];
  },
  renderHTML({ node }) {
    const latex = String(node.attrs.latex ?? "");
    return ["div", { class: "note-math-block", "data-math-block": latex }, `$$\n${latex}\n$$`];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "note-math-block";
      dom.contentEditable = "false";
      dom.innerHTML = katex.renderToString(String(node.attrs.latex ?? ""), { displayMode: true, throwOnError: false, output: "html" });
      return { dom };
    };
  },
  markdownTokenName: "blockMath",
  markdownTokenizer: {
    name: "blockMath",
    level: "block",
    start: (src: string) => src.search(/^ {0,3}\$\$/m),
    tokenize(src) {
      const match = BLOCK_MATH.exec(src);
      if (!match) return undefined;
      return { type: "blockMath", raw: match[0], text: match[1].trim() };
    },
  },
  parseMarkdown: (token, h) => h.createNode("blockMath", { latex: String(token.text ?? "") }),
  renderMarkdown: (node) => `$$\n${String(node.attrs?.latex ?? "")}\n$$`,
});

/** Drops the zero-width spaces KaTeX pads its layout with, which would end up in the text. */
function stripZeroWidth(root: ParentNode) {
  const node = root as unknown as globalThis.Node;
  const walker = (node.ownerDocument ?? document).createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.nodeValue?.includes("​")) text.nodeValue = text.nodeValue.replace(/​/g, "");
  }
}

/**
 * Readies rendered math in copied HTML for pasting: each formula is marked with its LaTeX (`data-math-block`,
 * `data-math-inline`), which the note editor reads back as math, and keeps only its MathML, which other apps show,
 * not also its visual layout, which they'd paste as a second, garbled copy of it.
 */
export function cleanMathForClipboard(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".katex-display").forEach((display) => display.setAttribute("data-math-block", texOf(display)));
  root.querySelectorAll<HTMLElement>(".katex").forEach((math) => {
    if (!math.closest(".katex-display")) math.setAttribute("data-math-inline", texOf(math));
  });
  root.querySelectorAll(".katex-html").forEach((layout) => layout.remove());
  stripZeroWidth(root);
}

/** Blocks and formatting a copied selection may sit inside, kept around it so it pastes as what it was. */
const COPIED_ANCESTORS = new Set([
  ...["H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "CODE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR"],
  ...["STRONG", "B", "EM", "I", "DEL", "S", "A"],
]);
const TEXT_BLOCKS = /^(P|DIV|H[1-6]|LI|UL|OL|PRE|BLOCKQUOTE|TABLE|TR|HR)$/;

/** Plain text of copied HTML, its blocks on lines of their own and list items bulleted. */
function plainText(root: ParentNode): string {
  let out = "";
  const walk = (node: ParentNode, depth: number) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out += child.nodeValue ?? "";
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as HTMLElement;
      if (element.tagName === "BR") {
        out += "\n";
        continue;
      }
      const block = TEXT_BLOCKS.test(element.tagName);
      if (block && out && !out.endsWith("\n")) out += "\n";
      if (element.tagName === "LI") out += `${"  ".repeat(depth)}- `;
      if ((element.tagName === "TD" || element.tagName === "TH") && element.previousElementSibling) out += "\t";
      walk(element, element.tagName === "LI" ? depth + 1 : depth);
      if (block && !out.endsWith("\n")) out += "\n";
    }
  };
  walk(root, 0);
  return out.replace(/​/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The selection within `root` (a rendered reply or note) as clean HTML and plain text to put on the clipboard, or
 * `null` if nothing in it is selected. A selection starting or ending inside a formula takes all of it, as the
 * browser's would miss its MathML (and LaTeX) when started on the visible layout. The blocks it sits in (a list, a
 * heading) are kept around it. In the HTML, math is as `cleanMathForClipboard` leaves it; in the text, it's LaTeX.
 */
export function selectionToClipboard(root: HTMLElement): { html: string; text: string } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!root.contains(range.commonAncestorContainer)) return null;
  const formula = (node: globalThis.Node) => {
    const element = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
    const math = element?.closest(".katex-display") ?? element?.closest(".katex");
    return math && root.contains(math) ? math : null;
  };
  const start = formula(range.startContainer);
  if (start) range.setStartBefore(start);
  const end = formula(range.endContainer);
  if (end) range.setEndAfter(end);

  let content: globalThis.Node = range.cloneContents();
  const common = range.commonAncestorContainer;
  for (let el = common.nodeType === 1 ? (common as HTMLElement) : common.parentElement; el && el !== root; el = el.parentElement) {
    if (!COPIED_ANCESTORS.has(el.tagName)) continue;
    const wrapper = el.cloneNode(false);
    wrapper.appendChild(content);
    content = wrapper;
  }
  const html = root.ownerDocument.createElement("div");
  html.appendChild(content);
  const text = html.cloneNode(true) as HTMLElement;
  cleanMathForClipboard(html);
  text.querySelectorAll<HTMLElement>(".katex-display").forEach((display) => display.replaceWith(`\n$$\n${texOf(display)}\n$$\n`));
  text.querySelectorAll<HTMLElement>(".katex").forEach((math) => math.replaceWith(`$${texOf(math)}$`));
  return { html: html.innerHTML, text: plainText(text) };
}

/** A copy handler for rendered markdown: puts the selection on the clipboard as `selectionToClipboard` gives it. */
export function copyCleanSelection(event: { currentTarget: HTMLElement; clipboardData: DataTransfer; preventDefault(): void }) {
  const data = selectionToClipboard(event.currentTarget);
  if (!data) return;
  event.preventDefault();
  event.clipboardData.setData("text/html", data.html);
  event.clipboardData.setData("text/plain", data.text);
}

/**
 * Readies HTML pasted into a note: rendered math (KaTeX, or as copied above) becomes the math the editor reads, by its
 * LaTeX, leaving no layout or zero-width spaces behind; and a heading wholly in bold loses the bold, which a heading
 * already is.
 */
export function transformNotePastedHTML(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>(".katex-display, [data-math-block]"))) {
    if (!element.isConnected) continue;
    const block = doc.createElement("div");
    block.setAttribute("data-math-block", element.getAttribute("data-math-block") || texOf(element));
    element.replaceWith(block);
  }
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>(".katex, .katex-mathml, [data-math-inline]"))) {
    if (!element.isConnected) continue;
    const tex = element.getAttribute("data-math-inline") || element.getAttribute("data-latex") || texOf(element) || element.textContent || "";
    const math = doc.createElement("span");
    math.setAttribute("data-math-inline", "");
    math.textContent = tex.trim();
    element.replaceWith(math);
  }
  doc.querySelectorAll(".katex-html").forEach((layout) => layout.remove());
  stripZeroWidth(doc.body);
  const bold = ["h1", "h2", "h3", "h4", "h5", "h6"].flatMap((h) => [`${h} > strong`, `${h} > b`]).join(", ");
  for (const strong of Array.from(doc.querySelectorAll(bold))) {
    const others = Array.from(strong.parentElement?.childNodes ?? []).filter(
      (n) => n !== strong && n.nodeType !== 8 && !(n.nodeType === 3 && !n.nodeValue?.trim()),
    );
    if (!others.length) strong.replaceWith(...Array.from(strong.childNodes));
  }
  return doc.body.innerHTML;
}
