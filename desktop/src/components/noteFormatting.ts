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
 * Images fill the page width, centered, as plain `![alt](url)`. One resized to a narrower layout column is saved as
 * an `<img>` with its width as a percentage, centered the same way:
 *
 *   <img src="/api/notes/image/1/shot.png" alt="" width="50%" style="display: block; margin: 0 auto" />
 */

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

type CellToken = { tokens?: MarkdownToken[]; align?: unknown; color?: string };
type TableToken = MarkdownToken & { header?: CellToken[]; rows?: CellToken[][] };

/** A table whose cells keep their color in markdown, wrapped in a background-colored span (see the top). */
export const ColoredTable = Table.extend({
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
    return this.parent?.(node, helpers, ctx) ?? "";
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

/** The layout columns, in percent of the page, an image snaps to when resized; full width is the default. */
export const IMAGE_WIDTHS = [25, 50, 75, 100] as const;

const IMAGE_STYLE = "display: block; margin: 0 auto";
const IMAGE_WIDTH = /^(\d{1,2})%$/;
const SIZED_IMAGE = /^<img src="([^"<>]*)" alt="([^"<>]*)"(?: title="([^"<>]*)")? width="(\d{1,2})%" style="display: block; margin: 0 auto" ?\/?>/;
/** One or more resized images alone on a line, which markdown would take for a block of raw HTML. */
const IMAGES_LINE = String.raw`(?:${SIZED_IMAGE.source.slice(1)}[ \t]*)+`;
const SIZED_IMAGE_LINE = new RegExp(String.raw`^${IMAGES_LINE}(?:\n+|$)`);
const ANY_SIZED_IMAGE_LINE = new RegExp(String.raw`^${IMAGES_LINE}$`, "m");

/** A width in percent narrower than the page (a whole 1–99), or `null`: full width. */
function imageWidth(value: unknown): number | null {
  const width = Number(value);
  return Number.isInteger(width) && width >= 1 && width < 100 ? width : null;
}

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
      const width = match && imageWidth(match[4]);
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
 * The image node with a `width` (a percentage of the page, `null` for the full width), saved as an `<img>` tag when
 * it's narrower (see the top). Its resize handles are a node view, added by the editor.
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
        parseHTML: (element: HTMLElement) => imageWidth(IMAGE_WIDTH.exec(element.getAttribute("width") ?? "")?.[1]),
        renderHTML: (attrs: Record<string, unknown>) => {
          const width = imageWidth(attrs.width);
          return width ? { width: `${width}%`, style: IMAGE_STYLE } : {};
        },
      },
      height: { default: null, rendered: false },
    };
  },
  renderMarkdown(node, h, ctx) {
    const width = imageWidth(node.attrs?.width);
    if (!width) return this.parent?.(node, h, ctx) ?? "";
    const { src, alt, title } = node.attrs ?? {};
    return `<img src="${attribute(src)}" alt="${attribute(alt)}"${title ? ` title="${attribute(title)}"` : ""} width="${width}%" style="${IMAGE_STYLE}" />`;
  },
});

const CSS_COLOR = String.raw`(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))`;
const CELL_STYLE = new RegExp(`^background-color: ?${CSS_COLOR};?$`, "i");

/** The sanitizer schema for rendering notes: GitHub's defaults, plus the colors, alignment divs and image sizes above. */
export const NOTE_HTML_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["style", new RegExp(`^(background-)?color: ?${CSS_COLOR};?$`, "i")]],
    div: [...(defaultSchema.attributes?.div ?? []), ["style", /^text-align: ?(left|center|right);?$/]],
    td: [...(defaultSchema.attributes?.td ?? []), ["style", CELL_STYLE]],
    th: [...(defaultSchema.attributes?.th ?? []), ["style", CELL_STYLE]],
    img: [...(defaultSchema.attributes?.img ?? []), ["width", IMAGE_WIDTH], ["style", IMAGE_STYLE]],
  },
};
