import type { ImageOptions } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit, TableView } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
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
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { errorDetail, message } from "../lib/api";
import ImageLightbox, { ExpandButton } from "./ImageLightbox";
import {
  ALIGNMENTS,
  AlignedBlocks,
  AlignedHeading,
  AlignedParagraph,
  ColoredTable,
  ColoredTableCell,
  ColoredTableHeader,
  ColoredTextStyle,
  NOTE_COLUMN,
  SizedImage,
  guideOffsets,
  mediaStyle,
  mediaWidth,
  nearestWidth,
  snapWidths,
  widthLabel,
  type Alignment,
} from "./noteFormatting";

/**
 * A rich-text editor over a note's title and markdown body (front-matter is kept by the backend), laid out like a
 * Confluence page: a sticky formatting toolbar across the page, then the title, `children` (the note's properties
 * and tasks), and the body in a centered text column, edited rendered and handed back as markdown. Pasted or dropped
 * images and files are uploaded to the space (a file is linked by name), and an image opens fullscreen to be marked
 * up. Ctrl/Cmd+S saves.
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

  /**
   * Upload files one by one, inserting each at `pos` (or the selection) once it's stored: an image as itself, any
   * other file as a link named after it.
   */
  async function insertFiles(view: EditorView, files: File[], pos?: number) {
    setUploadError(null);
    setUploads((n) => n + files.length);
    for (const file of files) {
      try {
        const { url, name } = await uploadFile(spaceId, file);
        const { schema } = view.state;
        const node = file.type.startsWith("image/")
          ? schema.nodes.image.create({ src: url })
          : schema.text(name, [schema.marks.link.create({ href: url })]);
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
  const insertFilesRef = useRef(insertFiles);
  insertFilesRef.current = insertFiles;
  const uploadRef = useRef(async (file: File) => (await uploadFile(spaceId, file)).url);
  uploadRef.current = async (file: File) => (await uploadFile(spaceId, file)).url;

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
      // The table and its cells are swapped for ones that save cell colors and the table's width (see
      // noteFormatting), shown with a handle to resize it (`WideTableView`).
      TableKit.configure({ table: false, tableCell: false, tableHeader: false }),
      ColoredTable.configure({ resizable: true, cellMinWidth: 60, View: WideTableView }),
      ColoredTableCell,
      ColoredTableHeader,
      // Inline, as markdown images are: `![](url)` sits in a paragraph, so saved notes parse back the same. Shown
      // column-wide and centered, with handles to resize it to a layout column or the page (see noteFormatting). A
      // marked-up image is uploaded as a new one.
      ResizableImage.configure({ inline: true, allowBase64: false, upload: (file: File) => uploadRef.current(file) }),
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
      // A pasted screenshot or a dropped file is uploaded to the space rather than inlined as base64.
      handlePaste: (view, event) => {
        const files = extractFiles(event.clipboardData);
        if (!files.length || !view.editable) return false;
        event.preventDefault();
        void insertFilesRef.current(view, files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : extractFiles(event.dataTransfer);
        if (!files.length || !view.editable) return false;
        event.preventDefault();
        void insertFilesRef.current(view, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
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
      <Toolbar editor={editor} status={uploads > 0 ? `Uploading ${uploads > 1 ? `${uploads} files` : "file"}…` : null} />
      {uploadError && <p className={`${NOTE_COLUMN} pt-3 text-[13px] text-accent`}>{uploadError}</p>}
      <TitleInput
        value={title}
        onChange={onTitleChange}
        disabled={disabled}
        onSave={() => onSaveRef.current()}
        onDone={() => editor?.commands.focus("start")}
      />
      {children && <div className={`${NOTE_COLUMN} flex flex-col gap-5 pt-5`}>{children}</div>}
      <EditorContent editor={editor} className="pt-4" />
    </div>
  );
}

const ResizableImage = SizedImage.extend<ImageOptions & { upload: ((file: File) => Promise<string>) | null }>({
  addOptions() {
    return { ...(this.parent?.() as ImageOptions), upload: null };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, {
      className: "note-image",
      // The handles' drags and the expand button's clicks are the view's own, not a node drag or a click for the editor.
      stopEvent: ({ event }) => event.target instanceof Element && !!event.target.closest("[data-resize-handle], [data-image-expand]"),
    });
  },
});

/**
 * An image laid out like a Confluence one: centered at its width (a percentage of the text column, full by default)
 * and, when selected, with a handle on each side. Dragging one resizes it symmetrically, snapping to the layout
 * columns that fit the page and to its full width, which show as guide lines over it while it's dragged. Double-click
 * it, or its expand button on hover, to open it fullscreen, where it can be marked up while the note is editable.
 */
function ImageView({ node, selected, editor, extension, updateAttributes }: NodeViewProps) {
  const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
  const width = (node.attrs.width as number | null) ?? 100;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // Kept after a drag, so the guides fade out where they were.
  const [snaps, setSnaps] = useState<number[]>([]);
  const columnRef = useRef<HTMLSpanElement>(null);
  const imageRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const shown = dragWidth ?? width;
  const upload = (extension.options as { upload: ((file: File) => Promise<string>) | null }).upload;

  /** Store a marked-up copy of the image and show it in the note instead. */
  async function saveMarkup(image: Blob) {
    if (!upload) return;
    const stored = await upload(new File([image], "markup.png", { type: "image/png" }));
    updateAttributes({ src: stored });
  }

  function startResize(event: ReactPointerEvent, side: -1 | 1) {
    const column = columnRef.current?.getBoundingClientRect().width;
    const canvas = columnRef.current?.closest(".note-body")?.clientWidth;
    const start = imageRef.current?.getBoundingClientRect().width;
    if (!column || !canvas || !start) return;
    event.preventDefault();
    const widths = snapWidths(column, canvas);
    setSnaps(widths);
    setDragWidth(width);
    const startX = event.clientX;
    let snapped = width;
    // Centered, so each side moves by the drag: the width changes by twice it.
    const move = (e: PointerEvent) => {
      snapped = nearestWidth(((start + side * 2 * (e.clientX - startX)) / column) * 100, widths, (canvas / column) * 100);
      setDragWidth(snapped);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDragWidth(null);
      if (snapped !== width) updateAttributes({ width: mediaWidth(snapped) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return (
    <NodeViewWrapper as="span" ref={columnRef} className="relative my-3 block">
      <span aria-hidden className={`media-guides ${dragWidth === null ? "" : "dragging"}`}>
        {snaps.flatMap((w) =>
          guideOffsets(w).map((left) => (
            <span key={`${w}-${left}`} className={`media-guide ${w === shown ? "on" : ""}`} style={{ left }} />
          )),
        )}
      </span>
      <span ref={imageRef} className="note-media group relative block" style={{ "--media-scale": shown / 100 } as CSSProperties}>
        <img
          src={src}
          alt={alt ?? ""}
          title={title ?? undefined}
          draggable={false}
          onDoubleClick={() => setExpanded(true)}
          className={selected ? "outline outline-2 outline-accent" : undefined}
        />
        {dragWidth === null && <ExpandButton onClick={() => setExpanded(true)} />}
        {selected && editor.isEditable && (
          <>
            <ResizeHandle side={-1} onPointerDown={(e) => startResize(e, -1)} />
            <ResizeHandle side={1} onPointerDown={(e) => startResize(e, 1)} />
          </>
        )}
        {dragWidth !== null && <span className="media-width-label">{widthLabel(dragWidth)}</span>}
      </span>
      {expanded && (
        <ImageLightbox
          src={src}
          alt={alt}
          title={title}
          onClose={() => setExpanded(false)}
          onSave={editor.isEditable && upload ? saveMarkup : undefined}
        />
      )}
    </NodeViewWrapper>
  );
}

/**
 * The table's view in the editor, around prosemirror-tables' (which resizes its columns): the table sits in a
 * `note-media` box at its width, centered on the text column, with a handle on its right edge on hover. Dragging it
 * resizes the table symmetrically, snapping to the layout columns that fit the page and to its full width, shown as
 * guide lines while it's dragged, as an image's are.
 */
class WideTableView extends TableView {
  view: EditorView;
  media: HTMLDivElement;
  guides: HTMLDivElement;
  label: HTMLSpanElement;

  constructor(node: ProseMirrorNode, cellMinWidth: number, view: EditorView) {
    super(node, cellMinWidth, view);
    this.view = view;
    const wrapper = this.dom;
    this.dom = document.createElement("div");
    this.dom.className = "note-table";
    this.guides = this.dom.appendChild(document.createElement("div"));
    this.guides.className = "media-guides";
    this.guides.setAttribute("aria-hidden", "true");
    this.media = this.dom.appendChild(document.createElement("div"));
    this.media.className = "note-media relative";
    this.media.append(wrapper);
    const handle = this.media.appendChild(document.createElement("span"));
    handle.dataset.resizeHandle = "";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Resize the table");
    handle.className = `table-width-handle ${HANDLE_CLASS} -right-3`;
    handle.addEventListener("pointerdown", (e) => this.startResize(e));
    this.label = document.createElement("span");
    this.label.className = "media-width-label";
    this.showWidth(this.width());
  }

  update(node: ProseMirrorNode) {
    if (!super.update(node)) return false;
    this.showWidth(this.width());
    return true;
  }

  // The handle's drags are the view's own, not a selection for the editor.
  stopEvent(event: Event) {
    return event.target instanceof Element && !!event.target.closest("[data-resize-handle]");
  }

  width(): number {
    return (this.node.attrs.width as number | null) ?? 100;
  }

  showWidth(width: number) {
    this.media.setAttribute("style", mediaStyle(width));
  }

  startResize(event: PointerEvent) {
    const column = this.dom.getBoundingClientRect().width;
    const canvas = this.view.dom.clientWidth;
    const start = this.media.getBoundingClientRect().width;
    if (!this.view.editable || !column || !start) return;
    event.preventDefault();
    const width = this.width();
    const widths = snapWidths(column, canvas);
    const lines = widths.flatMap((w) =>
      guideOffsets(w).map((left) => {
        const line = document.createElement("span");
        line.className = "media-guide";
        line.style.left = left;
        return { w, line };
      }),
    );
    const show = (w: number) => {
      this.showWidth(w);
      for (const line of lines) line.line.classList.toggle("on", line.w === w);
      this.label.textContent = widthLabel(w);
    };
    this.guides.replaceChildren(...lines.map(({ line }) => line));
    this.guides.classList.add("dragging");
    this.dom.classList.add("resizing");
    this.media.append(this.label);
    show(width);
    const startX = event.clientX;
    let snapped = width;
    // Centered, so the right edge moves by the drag and the width by twice it.
    const move = (e: PointerEvent) => {
      snapped = nearestWidth(((start + 2 * (e.clientX - startX)) / column) * 100, widths, (canvas / column) * 100);
      show(snapped);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this.guides.classList.remove("dragging");
      this.dom.classList.remove("resizing");
      this.label.remove();
      this.showWidth(width);
      if (snapped === width) return;
      // The view isn't given its position (prosemirror-tables makes it), so find the table it shows.
      let pos = -1;
      this.view.state.doc.descendants((n, p) => {
        if (n === this.node) pos = p;
        return pos < 0;
      });
      if (pos >= 0) this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width: mediaWidth(snapped) }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
}

const HANDLE_CLASS = "absolute top-1/2 h-10 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border border-background bg-accent";

function ResizeHandle({ side, onPointerDown }: { side: -1 | 1; onPointerDown: (event: ReactPointerEvent) => void }) {
  return (
    <span
      data-resize-handle
      role="separator"
      aria-label={side < 0 ? "Resize from the left" : "Resize from the right"}
      onPointerDown={onPointerDown}
      className={`${HANDLE_CLASS} ${side < 0 ? "-left-1" : "-right-1"}`}
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
      className={`${NOTE_COLUMN} mt-5 block resize-none overflow-hidden bg-transparent text-[32px] font-semibold leading-tight text-text-primary placeholder:text-text-muted focus:outline-none`}
    />
  );
}

/** The files of a paste or drop, if any. */
function extractFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []);
}

/** POST /api/notes/image: store an image or other file in the space, returning the URL it's served from and its name. */
async function uploadFile(spaceId: number, file: File): Promise<{ url: string; name: string }> {
  const form = new FormData();
  form.append("space_id", String(spaceId));
  form.append("file", file);
  const res = await fetch("/api/notes/image", { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorDetail(res));
  return { url: ((await res.json()) as { url: string }).url, name: file.name };
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
