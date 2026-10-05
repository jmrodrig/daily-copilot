import {
  Extension,
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
import type { Element, Root } from "hast";
import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

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
 */

/** The text column a note's title, properties and body sit in, centered on the page (see `.note-body` in index.css). */
export const NOTE_COLUMN = "mx-auto w-full max-w-4xl";

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

/** The sanitizer schema for rendering notes: GitHub's defaults, plus the colors, alignment and width divs and image sizes above. */
export const NOTE_HTML_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
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
