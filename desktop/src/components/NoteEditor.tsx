import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import type { EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { errorDetail, message } from "../lib/api";
import {
  ALIGNMENTS,
  AlignedBlocks,
  AlignedHeading,
  AlignedParagraph,
  ColoredTable,
  ColoredTableCell,
  ColoredTableHeader,
  ColoredTextStyle,
  IMAGE_WIDTHS,
  SizedImage,
  type Alignment,
} from "./noteFormatting";

/**
 * A rich-text editor over a note's title and markdown body (front-matter is kept by the backend), laid out like a
 * Confluence page: a sticky formatting toolbar, then the title, `children` (the note's properties and tasks), and
 * the body, edited rendered and handed back as markdown. Pasted or dropped images are uploaded to the space.
 * Ctrl/Cmd+S saves.
 */
export default function NoteEditor({
  spaceId,
  title,
  onTitleChange,
  value,
  onChange,
  onSave,
  disabled,
  children,
}: {
  spaceId: number;
  title: string;
  onTitleChange: (title: string) => void;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  // The callbacks change on every render of the page; the editor's handlers read the latest ones.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const [uploads, setUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /** Upload image files one by one, inserting each at `pos` (or the selection) once it's stored. */
  async function insertImages(view: EditorView, files: File[], pos?: number) {
    setUploadError(null);
    setUploads((n) => n + files.length);
    for (const file of files) {
      try {
        const src = await uploadImage(spaceId, file);
        const node = view.state.schema.nodes.image.create({ src });
        const tr = pos === undefined ? view.state.tr.replaceSelectionWith(node) : view.state.tr.insert(pos, node);
        if (pos !== undefined) pos += node.nodeSize;
        view.dispatch(tr.scrollIntoView());
      } catch (err) {
        setUploadError(`Could not upload ${file.name} (${message(err)}).`);
      } finally {
        setUploads((n) => n - 1);
      }
    }
  }
  const insertImagesRef = useRef(insertImages);
  insertImagesRef.current = insertImages;

  const editor = useEditor({
    extensions: [
      // Paragraphs and headings are swapped for ones that save their alignment (see noteFormatting).
      StarterKit.configure({ link: { openOnClick: false }, paragraph: false, heading: false }),
      AlignedParagraph,
      AlignedHeading,
      AlignedBlocks,
      TextAlign.configure({ types: ["heading", "paragraph"], alignments: [...ALIGNMENTS] }),
      ColoredTextStyle,
      Color,
      TaskList,
      TaskItem.configure({ nested: true }),
      // The table and its cells are swapped for ones that save cell colors (see noteFormatting).
      TableKit.configure({ table: false, tableCell: false, tableHeader: false }),
      ColoredTable.configure({ resizable: true, cellMinWidth: 60 }),
      ColoredTableCell,
      ColoredTableHeader,
      // Inline, as markdown images are: `![](url)` sits in a paragraph, so saved notes parse back the same. Shown
      // full width and centered, with handles to resize it to a layout column (see noteFormatting).
      ResizableImage.configure({ inline: true, allowBase64: false }),
      Markdown,
    ],
    // Parsed once: the editor owns the text from here, and NotePage remounts it for another note.
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "note-body markdown min-h-64 text-sm leading-relaxed text-text-secondary focus:outline-none", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveRef.current();
          return true;
        }
        return false;
      },
      // A pasted screenshot or a dropped image file is uploaded rather than inlined as base64.
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData);
        if (!files.length || !view.editable) return false;
        event.preventDefault();
        void insertImagesRef.current(view, files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : imageFiles(event.dataTransfer);
        if (!files.length || !view.editable) return false;
        event.preventDefault();
        void insertImagesRef.current(view, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getMarkdown()),
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div className="flex flex-col">
      <Toolbar editor={editor} status={uploads > 0 ? `Uploading ${uploads > 1 ? `${uploads} images` : "image"}…` : null} />
      {uploadError && <p className="pt-3 text-[13px] text-accent">{uploadError}</p>}
      <TitleInput
        value={title}
        onChange={onTitleChange}
        disabled={disabled}
        onSave={() => onSaveRef.current()}
        onDone={() => editor?.commands.focus("start")}
      />
      {children && <div className="flex flex-col gap-5 pt-5">{children}</div>}
      <EditorContent editor={editor} className="pt-4" />
    </div>
  );
}

const ResizableImage = SizedImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, {
      className: "note-image",
      // The handles' drags are the view's own, not a node drag or a click for the editor.
      stopEvent: ({ event }) => event.target instanceof Element && !!event.target.closest("[data-resize-handle]"),
    });
  },
});

/**
 * An image laid out like a Confluence one: centered at its width (a percentage of the page, full by default) and,
 * when selected, with a handle on each side. Dragging one resizes it symmetrically, snapping to the layout columns
 * of `IMAGE_WIDTHS`, which show as guide lines over the page while it's dragged.
 */
function ImageView({ node, selected, editor, updateAttributes }: NodeViewProps) {
  const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
  const width = (node.attrs.width as number | null) ?? 100;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const pageRef = useRef<HTMLSpanElement>(null);
  const imageRef = useRef<HTMLSpanElement>(null);
  const shown = dragWidth ?? width;

  function startResize(event: ReactPointerEvent, side: -1 | 1) {
    const page = pageRef.current?.getBoundingClientRect().width;
    const start = imageRef.current?.getBoundingClientRect().width;
    if (!page || !start) return;
    event.preventDefault();
    const startX = event.clientX;
    let snapped = width;
    // Centered, so each side moves by the drag: the width changes by twice it.
    const move = (e: PointerEvent) => {
      snapped = nearestWidth(((start + side * 2 * (e.clientX - startX)) / page) * 100);
      setDragWidth(snapped);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDragWidth(null);
      if (snapped !== width) updateAttributes({ width: snapped === 100 ? null : snapped });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return (
    <NodeViewWrapper as="span" ref={pageRef} className="relative my-3 block">
      <span
        aria-hidden
        className={`pointer-events-none absolute -inset-y-2 inset-x-0 transition-opacity duration-150 ${dragWidth === null ? "opacity-0" : "opacity-100"}`}
      >
        {IMAGE_WIDTHS.flatMap((w) =>
          [(100 - w) / 2, (100 + w) / 2].map((x) => (
            <span
              key={`${w}-${x}`}
              className={`absolute inset-y-0 w-px ${w === shown ? "bg-accent" : "bg-text-muted/40"}`}
              style={{ left: `${x}%` }}
            />
          )),
        )}
      </span>
      <span ref={imageRef} className="relative mx-auto block" style={{ width: `${shown}%` }}>
        <img
          src={src}
          alt={alt ?? ""}
          title={title ?? undefined}
          draggable={false}
          className={selected ? "outline outline-2 outline-accent" : undefined}
        />
        {selected && editor.isEditable && (
          <>
            <ResizeHandle side={-1} onPointerDown={(e) => startResize(e, -1)} />
            <ResizeHandle side={1} onPointerDown={(e) => startResize(e, 1)} />
          </>
        )}
        {dragWidth !== null && (
          <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded bg-background/90 px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
            {dragWidth}%
          </span>
        )}
      </span>
    </NodeViewWrapper>
  );
}

/** The snap width nearest a dragged one. */
function nearestWidth(percent: number): number {
  return IMAGE_WIDTHS.reduce<number>((best, w) => (Math.abs(w - percent) < Math.abs(best - percent) ? w : best), 100);
}

function ResizeHandle({ side, onPointerDown }: { side: -1 | 1; onPointerDown: (event: ReactPointerEvent) => void }) {
  return (
    <span
      data-resize-handle
      role="separator"
      aria-label={side < 0 ? "Resize from the left" : "Resize from the right"}
      onPointerDown={onPointerDown}
      className={`absolute top-1/2 h-10 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border border-background bg-accent ${
        side < 0 ? "-left-1" : "-right-1"
      }`}
    />
  );
}

/** The note's title as a seamless heading: it wraps and grows like the read-only one. Enter moves on to the body. */
function TitleInput({
  value,
  onChange,
  disabled,
  onSave,
  onDone,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  onSave: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      disabled={disabled}
      aria-label="Title"
      placeholder="Untitled"
      spellCheck
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onDone();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          onSave();
        }
      }}
      className="mt-5 block w-full resize-none overflow-hidden bg-transparent text-[32px] font-semibold leading-tight text-text-primary placeholder:text-text-muted focus:outline-none"
    />
  );
}

/** The image files of a paste or drop, if any. */
function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((file) => file.type.startsWith("image/"));
}

/** POST /api/notes/image: store an image in the space, returning the URL it's served from. */
async function uploadImage(spaceId: number, file: File): Promise<string> {
  const form = new FormData();
  form.append("space_id", String(spaceId));
  form.append("file", file);
  const res = await fetch("/api/notes/image", { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorDetail(res));
  return ((await res.json()) as { url: string }).url;
}

function Toolbar({ editor, status }: { editor: Editor | null; status: string | null }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        strike: e.isActive("strike"),
        bulletList: e.isActive("bulletList"),
        orderedList: e.isActive("orderedList"),
        taskList: e.isActive("taskList"),
        table: e.isActive("table"),
        align: (ALIGNMENTS.find((a) => e.isActive({ textAlign: a })) ?? "left") as Alignment,
        // Only top-level blocks keep their alignment in markdown (see noteFormatting).
        alignable: e.state.selection.$from.depth === 1 && e.state.selection.$to.depth === 1,
        color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
        cellColor:
          ((e.getAttributes("tableCell").backgroundColor ?? e.getAttributes("tableHeader").backgroundColor) as string | null) ?? null,
        editable: e.isEditable,
      },
  });
  if (!editor || !active) return null;
  const chain = () => editor.chain().focus();
  const off = !active.editable;

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 -mx-2 flex min-h-11 flex-wrap items-center gap-0.5 border-b border-border-default bg-background px-2 py-1.5"
    >
      <ToolButton label="Bold (Ctrl+B)" on={active.bold} disabled={off} onClick={() => chain().toggleBold().run()}>
        <span className="font-bold">B</span>
      </ToolButton>
      <ToolButton label="Italic (Ctrl+I)" on={active.italic} disabled={off} onClick={() => chain().toggleItalic().run()}>
        <span className="font-serif italic">I</span>
      </ToolButton>
      <ToolButton label="Strikethrough" on={active.strike} disabled={off} onClick={() => chain().toggleStrike().run()}>
        <span className="line-through">S</span>
      </ToolButton>
      <ColorPicker
        label="Text color"
        colors={TEXT_COLORS}
        color={active.color}
        disabled={off}
        onPick={(color) => (color ? chain().setColor(color).run() : chain().unsetColor().run())}
      >
        <span className="font-semibold">A</span>
      </ColorPicker>
      <Divider />
      {ALIGNMENTS.map((align) => (
        <ToolButton
          key={align}
          label={`Align ${align}`}
          on={active.alignable && active.align === align}
          disabled={off || !active.alignable}
          onClick={() => chain().setTextAlign(align).run()}
        >
          <AlignIcon align={align} />
        </ToolButton>
      ))}
      <Divider />
      <ToolButton label="Bullet list" on={active.bulletList} disabled={off} onClick={() => chain().toggleBulletList().run()}>
        •≡
      </ToolButton>
      <ToolButton label="Numbered list" on={active.orderedList} disabled={off} onClick={() => chain().toggleOrderedList().run()}>
        1.
      </ToolButton>
      <ToolButton label="Checklist" on={active.taskList} disabled={off} onClick={() => chain().toggleTaskList().run()}>
        ☑
      </ToolButton>
      <Divider />
      <ToolButton
        label="Insert table"
        on={false}
        disabled={off || active.table}
        onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        ▦
      </ToolButton>
      {active.table && (
        // Shown only with the cursor in a table, and marked as such so the controls are easy to find.
        <div className="ml-1 flex items-center gap-0.5 rounded-md border border-accent/40 bg-accent/[0.06] pl-2">
          <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.06em] text-accent-soft">Table</span>
          <ColorPicker
            label="Cell color"
            colors={CELL_COLORS}
            color={active.cellColor}
            disabled={off}
            // A custom color is tinted like the swatches, so the cell's text stays readable.
            onPick={(color) =>
              chain()
                .setCellAttribute("backgroundColor", color?.length === 7 ? `${color}${CELL_TINT}` : color)
                .run()
            }
          >
            <CellIcon />
          </ColorPicker>
          <ToolText label="Add row below" disabled={off} onClick={() => chain().addRowAfter().run()}>
            + Row
          </ToolText>
          <ToolText label="Add column to the right" disabled={off} onClick={() => chain().addColumnAfter().run()}>
            + Column
          </ToolText>
          <ToolText label="Delete row" disabled={off} onClick={() => chain().deleteRow().run()}>
            − Row
          </ToolText>
          <ToolText label="Delete column" disabled={off} onClick={() => chain().deleteColumn().run()}>
            − Column
          </ToolText>
          <ToolText label="Delete table" disabled={off} onClick={() => chain().deleteTable().run()}>
            Delete table
          </ToolText>
        </div>
      )}
      {status && (
        <span role="status" className="ml-auto pl-3 text-xs text-text-muted">
          {status}
        </span>
      )}
    </div>
  );
}

function ToolButton({
  label,
  on,
  disabled,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={onClick}
      className={`flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

/** Text colors that read on the dark page, plus the default (no color). */
const TEXT_COLORS = [
  { name: "Red", value: "#ef6461" },
  { name: "Orange", value: "#f59e4b" },
  { name: "Yellow", value: "#f2d45c" },
  { name: "Green", value: "#56c8a8" },
  { name: "Blue", value: "#6cb6ea" },
  { name: "Purple", value: "#b7a3f2" },
  { name: "Pink", value: "#f28bc0" },
  { name: "Grey", value: "#97a5ae" },
];

/** Alpha appended to a cell color: a tint of it, which the text reads on. */
const CELL_TINT = "40";

/** Cell colors: tints of the text colors, plus the default (none). */
const CELL_COLORS = TEXT_COLORS.map((c) => ({ ...c, value: `${c.value}${CELL_TINT}` }));

/**
 * A color control: its icon (`children`) underlined in the current color, opening a grid of swatches, a reset to
 * the default, and a custom picker.
 */
function ColorPicker({
  label,
  colors,
  color,
  disabled,
  onPick,
  children,
}: {
  label: string;
  colors: { name: string; value: string }[];
  color: string | null;
  disabled: boolean;
  onPick: (color: string | null) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const pick = (value: string | null) => {
    onPick(value);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <ToolButton label={label} on={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span className="flex flex-col items-center leading-none">
          {children}
          <span className="mt-0.5 h-[3px] w-3.5 rounded-sm" style={{ background: color ?? "currentColor" }} />
        </span>
      </ToolButton>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-[184px] rounded-md border border-border-default bg-surface-raised p-2 shadow-lg">
          <div className="grid grid-cols-4 gap-1.5">
            {colors.map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.name}
                aria-label={c.name}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c.value)}
                className={`h-7 rounded border ${color?.toLowerCase() === c.value ? "border-text-primary" : "border-transparent"} hover:border-border-strong`}
                style={{ background: c.value }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-default pt-2">
            <ToolText label={`Remove ${label.toLowerCase()}`} disabled={false} onClick={() => pick(null)}>
              Default
            </ToolText>
            <label className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary">
              Custom
              <input
                type="color"
                aria-label={`Custom ${label.toLowerCase()}`}
                value={color && /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : "#ffffff"}
                // Applied as it's dragged; the editor's selection is kept, so the change lands on the same text.
                onChange={(e) => onPick(e.target.value)}
                className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small grid with its top-left cell filled. */
function CellIcon() {
  return (
    <svg aria-hidden width="14" height="12" viewBox="0 0 14 12" stroke="currentColor" strokeWidth="1.2">
      <rect x="1" y="1" width="6" height="5" fill="currentColor" fillOpacity="0.45" stroke="none" />
      <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1" fill="none" />
      <line x1="7" x2="7" y1="0.6" y2="11.4" />
      <line x1="0.6" x2="13.4" y1="6" y2="6" />
    </svg>
  );
}

/** Four lines, ragged to show the alignment. */
function AlignIcon({ align }: { align: Alignment }) {
  const lines = [14, 9, 14, 9];
  const x = (width: number) => (align === "left" ? 1 : align === "right" ? 15 - width : (16 - width) / 2);
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      {lines.map((width, i) => (
        <line key={i} x1={x(width)} x2={x(width) + width} y1={3 + i * 3.4} y2={3 + i * 3.4} />
      ))}
    </svg>
  );
}

function ToolText({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="h-8 rounded px-2 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />;
}
