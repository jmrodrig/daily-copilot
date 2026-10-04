import { Extension, type JSONContent } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import Paragraph from "@tiptap/extension-paragraph";
import { TextStyle } from "@tiptap/extension-text-style";
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
 */

export const ALIGNMENTS = ["left", "center", "right"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

/** Hex colors, as the picker gives them, or the rgb() ones the browser turns pasted styles into. */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
const SPAN = /^<span style="color: ?([^";<>]+?);?">([\s\S]*?)<\/span>/;
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

/** The sanitizer schema for rendering notes: GitHub's defaults, plus the color spans and alignment divs above. */
export const NOTE_HTML_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["style", /^color: ?(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\));?$/i]],
    div: [...(defaultSchema.attributes?.div ?? []), ["style", /^text-align: ?(left|center|right);?$/]],
  },
};
