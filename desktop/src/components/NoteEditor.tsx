import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * A rich-text editor over a note's markdown body (front-matter is kept by the backend): the text is edited rendered,
 * under a sticky formatting toolbar, and handed back as markdown. Ctrl/Cmd+S saves.
 */
export default function NoteEditor({
  value,
  onChange,
  onSave,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  // The callbacks change on every render of the page; the editor's handlers read the latest ones.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
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
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getMarkdown()),
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div className="flex flex-col">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="pt-4" />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
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
      className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-0.5 border-b border-border-default bg-background px-2 py-1.5"
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
        <>
          <ToolText label="Add row" disabled={off} onClick={() => chain().addRowAfter().run()}>
            + Row
          </ToolText>
          <ToolText label="Add column" disabled={off} onClick={() => chain().addColumnAfter().run()}>
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
        </>
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
      className="h-8 rounded px-2 text-xs text-text-muted hover:bg-surface-raised hover:text-text-primary disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />;
}
