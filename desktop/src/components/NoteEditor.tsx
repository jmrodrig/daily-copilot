import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { errorDetail, message } from "../lib/api";

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
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true, cellMinWidth: 60 } }),
      // Inline, as markdown images are: `![](url)` sits in a paragraph, so saved notes parse back the same.
      Image.configure({ inline: true, allowBase64: false }),
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
