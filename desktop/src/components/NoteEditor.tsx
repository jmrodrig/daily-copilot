import { Extension, getMarkRange } from "@tiptap/core";
import type { ImageOptions } from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit, TableView } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import "katex/dist/katex.min.css";

import { message, uploadFile } from "../lib/api";
import { checkLocalFile, isLocalHref, openLocalFile } from "../lib/localFiles";
import type { TaskItem as TaskRow } from "../lib/tasks";
import MediaLightbox, { ExpandButton, isPdfUrl, MarkupOverlay } from "./MediaLightbox";
import { LinkPanel, panelPosition, TaskPanel, type PanelDraft } from "./refPanels";
import {
  BARE_URL,
  fetchUrlTitle,
  isWebUrl,
  linkPill,
  pastedLink,
  pillBareUrlsInMarkdown,
  pillContent,
  ReferencePill,
  taskHref,
  titleFromUrlSlug,
  trimUrl,
  type RefPillAttrs,
} from "./referencePill";
import { SlashCommand, SlashMenu, type SlashItem, type SlashMenuState } from "./slashCommand";
import { WhiteboardIcon } from "./markupUi";
import { WhiteboardNode } from "./WhiteboardWidget";
import {
  ActiveListenWidget,
  LISTEN_REMOVAL_CONFIRMED,
  ListenNode,
  ListenRemovalDialog,
  ListenRemovalGuard,
  MicIcon,
  type ListenRemoval,
} from "./ListenWidget";
import {
  ALIGNMENTS,
  AlignedBlocks,
  AlignedHeading,
  AlignedParagraph,
  BlockMath,
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
  EMPTY_WHITEBOARD_JSON,
  newListenJson,
  InlineMath,
  localPathRanges,
  transformNotePastedHTML,
  type Alignment,
} from "./noteFormatting";

/**
 * A rich-text editor over a note's title and markdown body (front-matter is kept by the backend), laid out like a
 * Confluence page: a sticky formatting toolbar across the page, then the title, `children` (the note's properties
 * and tasks), and the body in a centered text column, edited rendered and handed back as markdown. Pasted or dropped
 * images and files are uploaded to the space (a file is linked by name), and an image or a linked PDF opens fullscreen
 * to be marked up. Ctrl/Cmd+S saves. Typing `/` offers to insert a task or a link, and selected text can be turned into either:
 * each goes in as an inline pill (see referencePill), replacing the selected text. With `notePath`, a new task can be
 * linked to the note. Without `title` the title field is left out, and `compact` fits the editor into a narrow pane (the
 * task panel's description) rather than a page.
 */
export default function NoteEditor({
  spaceId,
  notePath,
  title,
  onTitleChange,
  value,
  onChange,
  onSave,
  onTaskCreated,
  disabled,
  compact = false,
  children,
}: {
  spaceId: number;
  notePath?: string;
  title?: string;
  onTitleChange?: (title: string) => void;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onTaskCreated?: (task: TaskRow) => void;
  disabled: boolean;
  compact?: boolean;
  children?: ReactNode;
}) {
  // A page centres its text in a wide column; a narrow pane uses all of its width.
  const column = compact ? "w-full" : NOTE_COLUMN;
  // The callbacks change on every render of the page; the editor's handlers read the latest ones.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const [uploads, setUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ type: "task" | "link"; draft: PanelDraft } | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  // The `/` menu's key handling while it's shown (see SlashMenu), and what picking one of its items does.
  const slashKeyRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const slashPickRef = useRef<(item: SlashItem, range: { from: number; to: number }) => void>(() => {});
  // The listen widget recording or being transcribed (see ActiveListenWidget), and an edit that would remove one that
  // is, or that holds a recording, held back till the removal is confirmed (see ListenRemovalGuard).
  const activeListenRef = useRef<string | null>(null);
  const [heldRemoval, setHeldRemoval] = useState<{ tr: Transaction; removal: ListenRemoval } | null>(null);

  const editor = useEditor({
    extensions: [
      // Paragraphs and headings are swapped for ones that save their alignment (see noteFormatting), and links for
      // ones that keep local paths (see NoteLink).
      StarterKit.configure({ link: false, paragraph: false, heading: false }),
      NoteLink.configure({
        openOnClick: false,
        protocols: ["file"],
        isAllowedUri: (url, { defaultValidate }) => isLocalHref(url) || defaultValidate(url),
      }),
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
      // column-wide and centered, with handles to resize it to a layout column or the page (see noteFormatting). Its
      // markup is kept beside it (see MediaLightbox), so the image itself is never changed.
      ResizableImage.configure({ inline: true, allowBase64: false }),
      // A ```whiteboard block, shown as a live board (see WhiteboardWidget).
      WhiteboardNode.configure({ spaceId, onSave: () => onSaveRef.current() }),
      // A ```listen block, shown as its recording widget (see ListenWidget).
      ListenNode,
      ListenRemovalGuard.configure({
        activeWidget: () => activeListenRef.current,
        onBlocked: (tr, removal) => setHeldRemoval({ tr, removal }),
      }),
      // `$…$` and `$$…$$`, shown rendered with KaTeX (see noteFormatting).
      InlineMath,
      BlockMath,
      Markdown,
      UploadPlaceholders,
      ReferencePill,
      SlashCommand.configure({
        onChange: setSlashMenu,
        onKeyDown: (event) => slashKeyRef.current(event),
        onPick: (item, range) => slashPickRef.current(item, range),
      }),
    ],
    // Parsed once: the editor owns the text from here, and NotePage remounts it for another note.
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: `note-body markdown ${compact ? "min-h-24 px-3 text-[15px]" : "min-h-64 text-[16px]"} leading-relaxed text-text-secondary focus:outline-none`,
        spellcheck: "true",
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveRef.current();
          return true;
        }
        return false;
      },
      // Math copied rendered (from the chat or a note) comes back as math, not its text twice over.
      transformPastedHTML: (html) => transformNotePastedHTML(html),
      // Bare web URLs in pasted text become link pills (outside code).
      transformPasted: (slice, view) => new Slice(pillBareUrls(slice.content, view.state.schema), slice.openStart, slice.openEnd),
      // A pasted screenshot or a dropped file is uploaded to the space rather than inlined as base64, a pasted link
      // becomes a link pill (over the selected text, which labels it), and markdown pasted as plain text (with no HTML
      // beside it) is read as markdown rather than taken literally. Local paths pasted as inline code or links become
      // pills once the paste has landed (see pillLocalPathsRef), and web-page pills labelled by their URL get the
      // page's title (see pillUrlTitlesRef).
      handlePaste: (view, event) => {
        if (!view.editable) return false;
        setTimeout(() => {
          void pillLocalPathsRef.current();
          void pillUrlTitlesRef.current();
        });
        const files = extractFiles(event.clipboardData);
        if (files.length) {
          event.preventDefault();
          void insertFilesRef.current(files);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const { $from } = view.state.selection;
        if ($from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) return false;
        const link = pastedLink(text);
        if (link) {
          event.preventDefault();
          pasteLinkRef.current(link);
          return true;
        }
        if (event.clipboardData?.getData("text/html") || !MARKDOWN_SYNTAX.test(text)) return false;
        event.preventDefault();
        pasteMarkdownRef.current(text.replace(/​/g, ""));
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : extractFiles(event.dataTransfer);
        if (!files.length || !view.editable) return false;
        event.preventDefault();
        void insertFilesRef.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getMarkdown()),
    // A note saved before images kept their paragraph may hold one loose in the doc: repair it quietly, so it
    // neither counts as an edit nor breaks the next one.
    onCreate: ({ editor }) => {
      const tr = normalizeDoc(editor.state);
      if (tr) editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
    },
  });

  const pasteMarkdownRef = useRef<(markdown: string) => void>(() => {});
  pasteMarkdownRef.current = (markdown: string) => {
    if (editor && !editor.isDestroyed) editor.commands.insertContent(pillBareUrlsInMarkdown(markdown), { contentType: "markdown" });
  };

  /** A pasted link as a pill: over the selected text, labelled by it, or at the caret, labelled by the link. */
  const pasteLinkRef = useRef<(href: string) => void>(() => {});
  pasteLinkRef.current = (href: string) => {
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    const label = editor.state.doc.textBetween(from, to, " ");
    insertPill({ text: label.replace(/\s+/g, " ").trim(), from, to, top: 0, left: 0 }, linkPill(href, label));
  };

  /**
   * Turn inline code holding a local path, and links to one, into link pills (see referencePill), as the chat cites
   * files: each the backend finds on disk, under the file's name (or the link's own text). Not an edit of its own to
   * undo: undoing the paste takes the pills too. A path not found is left as it was.
   */
  const pillLocalPathsRef = useRef<() => Promise<void>>(async () => {});
  pillLocalPathsRef.current = async () => {
    if (!editor || editor.isDestroyed) return;
    const paths = [...new Set(localPathRanges(editor.state.doc).map((range) => range.path))];
    if (!paths.length) return;
    const checks = await Promise.all(paths.map((path) => checkLocalFile(path)));
    if (editor.isDestroyed) return;
    const found = new Map(paths.flatMap((path, i) => (checks[i].exists ? [[path, checks[i].name || basename(path)] as const] : [])));
    const { state } = editor;
    const tr = state.tr;
    // From the end, so the ranges before each stay where they were. Found afresh: the doc may have changed meanwhile.
    for (const { from, to, path, label } of localPathRanges(state.doc).reverse()) {
      const name = found.get(path);
      if (name) tr.replaceWith(from, to, state.schema.nodes.referencePill.create({ kind: "url", href: path, label: label ?? name }));
    }
    if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
  };

  /**
   * Label web-page pills that show their bare URL (a pasted link, say) with the page's title, as the link panel does.
   * Like pillLocalPathsRef, not an edit of its own to undo. A page without a title keeps its URL.
   */
  const pillUrlTitlesRef = useRef<() => Promise<void>>(async () => {});
  pillUrlTitlesRef.current = async () => {
    if (!editor || editor.isDestroyed) return;
    const urls = [...new Set(untitledUrlPills(editor.state.doc).map((pill) => pill.href))];
    if (!urls.length) return;
    const titles = await Promise.all(urls.map((url) => fetchUrlTitle(url)));
    if (editor.isDestroyed) return;
    const found = new Map(urls.flatMap((url, i) => (titles[i] ? [[url, titles[i]] as const] : [])));
    // Found afresh: the doc may have changed meanwhile. A node's markup changes in place, so positions hold.
    const tr = editor.state.tr;
    for (const { pos, node, href } of untitledUrlPills(editor.state.doc)) {
      const title = found.get(href);
      if (title && title !== node.attrs.label) tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: title });
    }
    if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
  };

  // Reassigned every render, so an upload reads the current editor and space rather than the first render's.
  const insertFilesRef = useRef<(files: File[], pos?: number) => Promise<void>>(async () => {});
  insertFilesRef.current = async (files: File[], pos?: number) => {
    if (!editor || editor.isDestroyed) return;
    setUploadError(null);
    setUploads((n) => n + files.length);
    // Where the files go: the drop point, or after the selection (after a selected image, not before it). Each shows
    // there at once as a placeholder pill with a progress bar, which edits made while they upload carry along.
    const at = Math.min(Math.max(pos ?? editor.state.selection.to, 0), editor.state.doc.content.size);
    const batch = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const placeholders = files.map((file, order) => {
      const id = `${batch}-${order}`;
      const { dom, setProgress } = placeholderPill(file.name);
      editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id, pos: at, dom, order } } satisfies PlaceholderMeta));
      return { id, setProgress };
    });
    const removePlaceholder = (id: string) => editor.state.tr.setMeta(uploadPlaceholderKey, { remove: id } satisfies PlaceholderMeta);
    let pending = files.length;
    try {
      for (const [i, file] of files.entries()) {
        const { id, setProgress } = placeholders[i];
        try {
          const { url, name } = await uploadFile(spaceId, file, setProgress);
          if (editor.isDestroyed) return;
          const { state } = editor;
          const { schema } = state;
          const inline = file.type.startsWith("image/")
            ? [schema.nodes.image.create({ src: url })]
            : [schema.text(name, [schema.marks.link.create({ href: url })]), schema.text(" ")];
          const size = Fragment.from(inline).size;
          // At its placeholder, or after the selection if the text around that has been deleted.
          const $at = state.doc.resolve(placeholderPos(state, id) ?? state.selection.to);
          const tr = removePlaceholder(id);
          let end: number;
          if ($at.parent.inlineContent && $at.parent.canReplace($at.index(), $at.index(), Fragment.from(inline))) {
            // Within a paragraph or heading: inline, at the point.
            tr.insert($at.pos, inline);
            end = $at.pos + size;
          } else {
            // Between blocks (or in a block that can't take them): in a paragraph of their own, where one fits.
            const paragraph = schema.nodes.paragraph.create(null, inline);
            const point = insertPoint(state.doc, $at.pos, schema.nodes.paragraph) ?? state.doc.content.size;
            tr.insert(point, paragraph);
            end = point + 1 + size;
          }
          tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView();
          editor.view.dispatch(tr);
          editor.view.focus();
        } catch (err) {
          if (!editor.isDestroyed) editor.view.dispatch(removePlaceholder(id));
          setUploadError(`Could not upload ${file.name} (${message(err)}).`);
        } finally {
          pending--;
          setUploads((n) => n - 1);
        }
      }
    } finally {
      // Files never uploaded, the editor having gone, stop counting too.
      setUploads((n) => n - pending);
    }
  };

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  /** Open a panel for the text at `from`..`to` (or the caret, if they're the same). */
  function openPanel(type: "task" | "link", from: number, to: number) {
    if (!editor) return;
    const text = editor.state.doc.textBetween(from, to, " ").replace(/\s+/g, " ").trim();
    setPanel({ type, draft: { text, from, to, ...panelPosition(editor.view.coordsAtPos(from), editor.view.coordsAtPos(to)) } });
  }

  // The `/` and what was typed after it go, and the picked item's panel opens where they were.
  slashPickRef.current = (item, range) => {
    if (!editor) return;
    if (item.id === "whiteboard") {
      editor.chain().focus().deleteRange(range).insertContent({ type: "whiteboard", attrs: { data: EMPTY_WHITEBOARD_JSON } }).run();
      return;
    }
    if (item.id === "listen") {
      editor.chain().focus().deleteRange(range).insertContent({ type: "listen", attrs: { data: newListenJson() } }).run();
      return;
    }
    editor.chain().focus().deleteRange(range).run();
    openPanel(item.id, range.from, range.from);
  };

  /**
   * Put a pill where the panel's draft points: over the selected text, or at the caret. If the text there has
   * changed meanwhile (an upload landed, say), at the current selection instead.
   */
  function insertPill(draft: PanelDraft, pill: RefPillAttrs) {
    if (!editor || editor.isDestroyed) return;
    const { doc, selection } = editor.state;
    const size = doc.content.size;
    const intact = draft.to <= size && doc.textBetween(draft.from, draft.to, " ").replace(/\s+/g, " ").trim() === draft.text;
    const from = intact ? draft.from : selection.from;
    const to = intact ? draft.to : selection.to;
    // A space after the pill, so typing carries on past it, unless one's already there.
    const next = doc.textBetween(to, Math.min(to + 1, size));
    const content = pillContent(pill);
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, /\s/.test(next) ? content.slice(0, 1) : content)
      .run();
  }

  return (
    <div className={`flex flex-col ${compact ? "rounded-md border border-border-default" : ""}`}>
      <Toolbar
        editor={editor}
        compact={compact}
        status={uploads > 0 ? `Uploading ${uploads > 1 ? `${uploads} files` : "file"}…` : null}
        onAttach={(files) => editor && void insertFilesRef.current(files)}
      />
      {uploadError && <p className={`${column} pt-3 text-[15px] text-accent ${compact ? "px-3" : ""}`}>{uploadError}</p>}
      {title !== undefined && onTitleChange && (
        <TitleInput
          value={title}
          onChange={onTitleChange}
          disabled={disabled}
          onSave={() => onSaveRef.current()}
          onDone={() => editor?.commands.focus("start")}
        />
      )}
      {children && <div className={`${column} flex flex-col gap-5 pt-5`}>{children}</div>}
      <EditorContent editor={editor} className={compact ? "pb-1" : "pt-4"} />
      {editor && (
        <BubbleMenuWrapper editor={editor} />
      )}
      {editor && <PillMenuWrapper editor={editor} />}
      {editor && !panel && (
        <SelectionMenu editor={editor} onOpen={(type) => openPanel(type, editor.state.selection.from, editor.state.selection.to)} />
      )}
      {editor && slashMenu && !panel && <SlashMenu menu={slashMenu} keyHandler={slashKeyRef} />}
      {editor && panel?.type === "task" && (
        <TaskPanel
          spaceId={spaceId}
          notePath={notePath}
          draft={panel.draft}
          onCreated={(task) => {
            setPanel(null);
            insertPill(panel.draft, { kind: "task", href: taskHref(task.id), label: task.title });
            onTaskCreated?.(task);
          }}
          onClose={(refocus) => {
            setPanel(null);
            if (refocus) editor.commands.focus();
          }}
        />
      )}
      {editor && panel?.type === "link" && (
        <LinkPanel
          spaceId={spaceId}
          draft={panel.draft}
          onPick={(pill) => {
            setPanel(null);
            insertPill(panel.draft, pill);
          }}
          onClose={(refocus) => {
            setPanel(null);
            if (refocus) editor.commands.focus();
          }}
        />
      )}
      <ActiveListenWidget widgetRef={activeListenRef} />
      {editor && heldRemoval && (
        <ListenRemovalDialog
          removal={heldRemoval.removal}
          onKeep={() => {
            setHeldRemoval(null);
            editor.commands.focus();
          }}
          onRemove={() => {
            setHeldRemoval(null);
            // The edit as it was made, unless the note has changed since.
            const { tr } = heldRemoval;
            if (editor.isDestroyed || !tr.before.eq(editor.state.doc)) return false;
            editor.view.dispatch(tr.setMeta(LISTEN_REMOVAL_CONFIRMED, true));
            editor.commands.focus();
            return true;
          }}
        />
      )}
    </div>
  );
}

/**
 * The menu over selected text (not a link, which has its own): format it close to where it is (block type, bold,
 * italic, strikethrough, color, lists), or turn it into a task or a link.
 */
function SelectionMenu({ editor, onOpen }: { editor: Editor; onOpen: (type: "task" | "link") => void }) {
  const options = useMemo(() => ({ placement: "top" as const, offset: 8 }), []);
  const shouldShow = useCallback(
    ({ editor: e, state, from, to }: { editor: Editor; state: EditorState; from: number; to: number }) =>
      e.isEditable &&
      e.view.hasFocus() &&
      state.selection instanceof TextSelection &&
      !e.isActive("link") &&
      state.doc.textBetween(from, to, " ").trim() !== "",
    [],
  );
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      heading: (HEADING_LEVELS.find((level) => e.isActive("heading", { level })) ?? 0) as HeadingLevel,
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
    }),
  });
  const chain = () => editor.chain().focus();
  const button =
    "flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-bold uppercase tracking-wider text-text-secondary hover:bg-surface-hover hover:text-accent focus:outline-none";

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionMenu"
      options={options}
      shouldShow={shouldShow}
      className="flex items-center gap-0.5 rounded-lg border border-border-default bg-surface-raised p-0.5 shadow-xl"
    >
      {/* Each keeps the editor's selection until the click lands (see ToolButton). */}
      <div role="toolbar" aria-label="Format selection" className="flex items-center gap-0.5">
        <HeadingDropdown
          heading={active.heading}
          onSelect={(level) => (level === 0 ? chain().setParagraph().run() : chain().setHeading({ level }).run())}
        />
        <Divider />
        <ToolButton label="Bold (Ctrl+B)" on={active.bold} disabled={false} onClick={() => chain().toggleBold().run()}>
          <span className="font-bold">B</span>
        </ToolButton>
        <ToolButton label="Italic (Ctrl+I)" on={active.italic} disabled={false} onClick={() => chain().toggleItalic().run()}>
          <span className="font-serif italic">I</span>
        </ToolButton>
        <ToolButton label="Strikethrough" on={active.strike} disabled={false} onClick={() => chain().toggleStrike().run()}>
          <span className="line-through">S</span>
        </ToolButton>
        <ColorPicker
          label="Text color"
          colors={TEXT_COLORS}
          color={active.color}
          disabled={false}
          // A native color input takes the focus, which would close this menu.
          custom={false}
          onPick={(color) => (color ? chain().setColor(color).run() : chain().unsetColor().run())}
        >
          <span className="font-semibold">A</span>
        </ColorPicker>
        <Divider />
        <ToolButton label="Bullet list" on={active.bulletList} disabled={false} onClick={() => chain().toggleBulletList().run()}>
          •≡
        </ToolButton>
        <ToolButton label="Numbered list" on={active.orderedList} disabled={false} onClick={() => chain().toggleOrderedList().run()}>
          1.
        </ToolButton>
        <ToolButton label="Checklist" on={active.taskList} disabled={false} onClick={() => chain().toggleTaskList().run()}>
          ☑
        </ToolButton>
      </div>
      <Divider />
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpen("task")} title="Create a task from the selection" className={button}>
        <CheckboxIcon />
        Task
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpen("link")} title="Link the selection" className={button}>
        <LinkIcon />
        Link
      </button>
    </BubbleMenu>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.7 9.3a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2L8 3.8M9.3 6.7a3 3 0 0 0-4.2 0L2.7 9.1a3 3 0 0 0 4.2 4.2L8 12.2" />
    </svg>
  );
}

function CheckboxIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="10.6" height="10.6" rx="2" />
      <path d="M3.3 6.2l1.9 1.9 3.6-4" />
    </svg>
  );
}

/**
 * The menu under a selected web-page or local-file pill in an editable note: open it, or edit the pill's text and URL.
 */
function PillMenuWrapper({ editor }: { editor: Editor }) {
  const options = useMemo(() => ({ placement: "bottom" as const, offset: 8 }), []);
  const shouldShow = useCallback(
    ({ editor: e }: { editor: Editor }) => e.isEditable && e.isActive("referencePill") && e.getAttributes("referencePill").kind === "url",
    [],
  );
  const pill = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const attrs = e.getAttributes("referencePill") as Partial<RefPillAttrs>;
      return { pos: e.state.selection.from, href: attrs.href ?? "", label: attrs.label ?? "" };
    },
  });
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState("");
  const [href, setHref] = useState("");

  // Another pill (or none) selected: back to the buttons.
  useEffect(() => setEditing(false), [pill.pos]);

  function startEditing() {
    setLabel(pill.label);
    setHref(pill.href);
    setEditing(true);
  }

  function save() {
    const url = href.trim();
    if (!url) return;
    setEditing(false);
    editor.chain().focus().updateAttributes("referencePill", { label: label.trim() || url, href: url }).run();
  }

  const button = "px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-surface-hover focus:outline-none";

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="pillMenu"
      options={options}
      shouldShow={shouldShow}
      className="overflow-hidden rounded-lg border border-border-default bg-surface-raised shadow-xl"
    >
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setEditing(false);
            editor.commands.focus();
          }}
          aria-label="Edit link"
          className="flex w-[min(22rem,90vw)] flex-col gap-2 p-3"
        >
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Display text
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={href} className="field py-1 text-[15px]" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            URL
            <input value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://" className="field py-1 text-[15px]" />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                editor.commands.focus();
              }}
              className="btn min-h-0 px-2 py-1 text-xs"
            >
              Cancel
            </button>
            <button type="submit" disabled={!href.trim()} className="btn-primary min-h-0 px-2 py-1 text-xs">
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-center">
          <a
            href={pill.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              // The browser won't open a local path from a web page: the backend does (see openLocalFile).
              if (!isLocalHref(pill.href)) return;
              event.preventDefault();
              void openLocalFile(pill.href);
            }}
            className={`${button} text-accent`}
          >
            Open
          </a>
          <button
            type="button"
            // Keep the pill selected until the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={startEditing}
            className={`${button} flex items-center gap-1.5 border-l border-border-default text-text-secondary hover:text-accent`}
          >
            <PencilIcon />
            Edit
          </button>
        </div>
      )}
    </BubbleMenu>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.3 2.3a1.6 1.6 0 0 1 2.4 2.4L5.5 12.9 2.5 13.5l.6-3z" />
    </svg>
  );
}

/** True for a link to a file uploaded to the space (shown as a pill, see index.css). */
function isAttachmentHref(href: string | undefined): boolean {
  return !!href && href.includes("/api/notes/image/");
}

/**
 * The menu under a link: open it, and for an uploaded file in an editable note, remove it. A linked PDF opens in the
 * lightbox, to be marked up while the note is editable, as does a click on its pill. A link to a local file or folder
 * opens on this machine, or from the network share through a shortcut on a remote one (see openLocalFile), from the
 * Open button. Extracted so its props memoize
 * without cluttering NoteEditor's top-level hooks.
 */
function BubbleMenuWrapper({ editor }: { editor: Editor }) {
  const options = useMemo(() => ({ placement: "bottom" as const, offset: 8 }), []);
  const shouldShow = useCallback(({ editor: e }: { editor: Editor }) => e.isActive("link"), []);
  const link = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ href: e.getAttributes("link").href as string | undefined, editable: e.isEditable }),
  });
  // The PDF open in the lightbox: its link and name.
  const [pdf, setPdf] = useState<{ href: string; name: string } | null>(null);

  useEffect(() => {
    const dom = editor.view.dom;
    // A click on a link (or a local file's pill) only selects it, to open or edit from its menu; an uploaded PDF's pill
    // opens it in the lightbox.
    const click = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const href = anchor?.getAttribute("href") ?? undefined;
      if (!anchor || !isAttachmentHref(href) || !isPdfUrl(href!)) return;
      event.preventDefault();
      setPdf({ href: href!, name: anchor.textContent ?? "" });
    };
    dom.addEventListener("click", click);
    return () => dom.removeEventListener("click", click);
  }, [editor]);

  /** Delete the whole linked name, and the space inserted after it with the upload. */
  function removeAttachment() {
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .command(({ tr, state }) => {
        const { from, to } = tr.selection;
        const after = state.doc.textBetween(to, Math.min(to + 1, state.doc.content.size));
        tr.delete(from, after === " " ? to + 1 : to);
        return true;
      })
      .run();
  }

  return (
    <>
      <BubbleMenu
        editor={editor}
        options={options}
        shouldShow={shouldShow}
        className="flex items-center overflow-hidden rounded-lg border border-border-default bg-surface-raised shadow-xl"
      >
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (isLocalHref(link.href)) {
              event.preventDefault();
              void openLocalFile(link.href);
              return;
            }
            if (!isAttachmentHref(link.href) || !isPdfUrl(link.href!)) return;
            event.preventDefault();
            const { state } = editor;
            const range = getMarkRange(state.selection.$from, state.schema.marks.link);
            setPdf({ href: link.href!, name: range ? state.doc.textBetween(range.from, range.to) : "" });
          }}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-accent hover:bg-surface-hover focus:outline-none"
        >
          Open
        </a>
        {link.editable && isAttachmentHref(link.href) && (
          <button
            type="button"
            title="Remove attachment"
            aria-label="Remove attachment"
            // Keep the editor's selection on the link until the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={removeAttachment}
            className="flex items-center gap-1.5 border-l border-border-default px-3 py-2 text-xs font-bold uppercase tracking-wider text-text-secondary hover:bg-surface-hover hover:text-accent focus:outline-none"
          >
            <TrashIcon />
            Remove
          </button>
        )}
      </BubbleMenu>
      {pdf && <MediaLightbox src={pdf.href} title={pdf.name || null} onClose={() => setPdf(null)} editable={link.editable} />}
    </>
  );
}

/**
 * Links, allowed to point at local files and folders (`file:///…`, `C:\…`, `\\server\…`; see NoteEditor's config) rather
 * than stripped as unsafe. An href with spaces or brackets, as local paths often have, is saved as `[name](<href>)` so
 * it parses back, and a backslash before punctuation is doubled, as markdown reads `\\` and `\(` as escapes: a UNC
 * path (`\\server\…`) keeps both its leading backslashes.
 */
const NoteLink = Link.extend({
  renderMarkdown: (node, h) => {
    const href: string = (node.attrs?.href ?? "").replace(/\\(?=[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\\\");
    const title: string = node.attrs?.title ?? "";
    const target = /[\s()<>]/.test(href) ? `<${href}>` : href;
    return `[${h.renderChildren(node)}](${target}${title ? ` "${title}"` : ""})`;
  },
});

const ResizableImage = SizedImage.extend<ImageOptions>({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, {
      className: "note-image",
      // The handles' drags, the expand button's clicks and the caption's typing are the view's own, not the editor's.
      stopEvent: ({ event }) =>
        event.target instanceof Element && !!event.target.closest("[data-resize-handle], [data-image-expand], [data-image-caption]"),
    });
  },
});

/**
 * An image laid out like a Confluence one: centered at its width (a percentage of the text column, full by default)
 * and, when selected, with a handle on each side. Dragging one resizes it symmetrically, snapping to the layout
 * columns that fit the page and to its full width, which show as guide lines over it while it's dragged. Double-click
 * it, or its expand button on hover, to open it fullscreen, where it can be marked up while the note is editable.
 * Its caption, below it, is its markdown title (`![alt](src "title")`), editable while it's selected.
 */
function ImageView({ node, selected, editor, updateAttributes }: NodeViewProps) {
  const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
  const width = (node.attrs.width as number | null) ?? 100;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // Kept after a drag, so the guides fade out where they were.
  const [snaps, setSnaps] = useState<number[]>([]);
  const columnRef = useRef<HTMLSpanElement>(null);
  const imageRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Counted up as the lightbox closes, so the markup over the image is loaded again (it may have been changed there).
  const [opened, setOpened] = useState(0);
  // Kept while the caption is typed in, which may move the editor's selection off the image.
  const [captioning, setCaptioning] = useState(false);
  const shown = dragWidth ?? width;
  const editable = editor.isEditable;

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
        <MarkupOverlay src={src} version={opened} />
        {dragWidth === null && <ExpandButton onClick={() => setExpanded(true)} />}
        {selected && editor.isEditable && (
          <>
            <ResizeHandle side={-1} onPointerDown={(e) => startResize(e, -1)} />
            <ResizeHandle side={1} onPointerDown={(e) => startResize(e, 1)} />
          </>
        )}
        {dragWidth !== null && <span className="media-width-label">{widthLabel(dragWidth)}</span>}
      </span>
      {editable && (selected || captioning || title) ? (
        <input
          data-image-caption
          value={title ?? ""}
          onChange={(e) => updateAttributes({ title: e.target.value || null })}
          onFocus={() => setCaptioning(true)}
          onBlur={() => setCaptioning(false)}
          placeholder="Add a caption"
          aria-label="Image caption"
          className="mt-1.5 block w-full bg-transparent text-center text-[14px] italic text-text-secondary placeholder:text-text-muted focus:outline-none"
        />
      ) : (
        title && <span className="mt-1.5 block text-center text-[14px] italic text-text-secondary">{title}</span>
      )}
      {expanded && (
        <MediaLightbox
          src={src}
          alt={alt}
          title={title}
          onClose={() => {
            setExpanded(false);
            setOpened((n) => n + 1);
          }}
          editable={editor.isEditable}
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
      className={`${NOTE_COLUMN} mt-5 block resize-none overflow-hidden bg-transparent text-[33px] font-semibold leading-tight text-text-primary placeholder:text-text-muted focus:outline-none`}
    />
  );
}

/** A local path's last part: the file or folder's name. */
function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * The web-page pills in `doc` labelled by nothing but their URL (or the title made from it, which the page's own title
 * may yet replace), with where each is.
 */
function untitledUrlPills(doc: ProseMirrorNode): { pos: number; node: ProseMirrorNode; href: string }[] {
  const pills: { pos: number; node: ProseMirrorNode; href: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "referencePill") return true;
    const { kind, href, label } = node.attrs as RefPillAttrs;
    if (kind === "url" && isWebUrl(href) && (!label.trim() || label === href || label === titleFromUrlSlug(href))) pills.push({ pos, node, href });
    return false;
  });
  return pills;
}

/**
 * A transaction repairing a doc the schema doesn't allow, or `null` if it's valid: runs of inline nodes (an image
 * or text) sitting loose in the doc are gathered into paragraphs.
 */
function normalizeDoc(state: EditorState): Transaction | null {
  try {
    state.doc.check();
    return null;
  } catch {
    const { paragraph } = state.schema.nodes;
    const blocks: ProseMirrorNode[] = [];
    let run: ProseMirrorNode[] = [];
    const flush = () => {
      if (run.length) blocks.push(paragraph.create(null, run));
      run = [];
    };
    state.doc.forEach((child) => {
      if (child.isInline) {
        run.push(child);
      } else {
        flush();
        blocks.push(child);
      }
    });
    flush();
    const content = Fragment.from(blocks.length ? blocks : [paragraph.create()]);
    // Broken some other way: leave it be rather than guess.
    if (!state.doc.type.validContent(content)) return null;
    return state.tr.replaceWith(0, state.doc.content.size, content);
  }
}

/** The files of a paste or drop, if any. */
/**
 * Pasted content with its bare web URLs as link pills: in running text, and links whose text is their own URL. Code
 * (blocks and inline) and links with text of their own are left as they are.
 */
function pillBareUrls(fragment: Fragment, schema: Schema): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) nodes.push(...pillBareUrlsInText(node, schema));
    else if (node.type.spec.code || node.isLeaf) nodes.push(node);
    else nodes.push(node.copy(pillBareUrls(node.content, schema)));
  });
  return Fragment.fromArray(nodes);
}

function pillBareUrlsInText(node: ProseMirrorNode, schema: Schema): ProseMirrorNode[] {
  const text = node.text ?? "";
  if (node.marks.some((mark) => mark.type.spec.code)) return [node];
  const pill = (href: string) => schema.nodes.referencePill.create(linkPill(href));
  const link = node.marks.find((mark) => mark.type.name === "link");
  if (link) return pastedLink(text) === link.attrs.href ? [pill(link.attrs.href as string)] : [node];
  const nodes: ProseMirrorNode[] = [];
  let last = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    if (start > last) nodes.push(schema.text(text.slice(last, start), node.marks));
    nodes.push(pill(url));
    last = start + url.length;
  }
  if (!nodes.length) return [node];
  if (last < text.length) nodes.push(schema.text(text.slice(last), node.marks));
  return nodes;
}

function extractFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []);
}

/**
 * Plain text that reads as markdown: a heading, list item, quote, fence or table row starting a line, or inline
 * math, bold or a link anywhere.
 */
const MARKDOWN_SYNTAX = /^ {0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\$\$|\|.*\|)|\$[^\s$][^$\n]*\$|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/m;

type PlaceholderMeta = { add: { id: string; pos: number; dom: HTMLElement; order: number } } | { remove: string };

/**
 * Placeholders for files being uploaded: a pill with a progress bar, shown as a widget decoration where each file
 * will go. Being a decoration, not a node, it is never saved to markdown or caught up in undo, and it moves with edits
 * made around it. A transaction adds one with the meta `{ add: { id, pos, dom, order } }` and drops it with
 * `{ remove: id }`.
 */
const uploadPlaceholderKey = new PluginKey<DecorationSet>("uploadPlaceholder");

const UploadPlaceholders = Extension.create({
  name: "uploadPlaceholders",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: uploadPlaceholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(uploadPlaceholderKey) as PlaceholderMeta | undefined;
            if (meta && "add" in meta) {
              const { id, pos, dom, order } = meta.add;
              // A positive side keeps a placeholder after a file inserted at its position, so the files queue up in order.
              set = set.add(tr.doc, [Decoration.widget(pos, dom, { id, side: 1 + order, ignoreSelection: true })]);
            } else if (meta && "remove" in meta) {
              set = set.remove(set.find(undefined, undefined, (spec) => spec.id === meta.remove));
            }
            return set;
          },
        },
        props: {
          decorations: (state) => uploadPlaceholderKey.getState(state),
        },
      }),
    ];
  },
});

/** Where an upload's placeholder is now, or null if the text around it has been deleted. */
function placeholderPos(state: EditorState, id: string): number | null {
  const found = uploadPlaceholderKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0].from : null;
}

/** A placeholder pill: the file's name over a bar that fills as it uploads (`setProgress`). */
function placeholderPill(name: string): { dom: HTMLElement; setProgress: (fraction: number) => void } {
  const dom = document.createElement("span");
  dom.className = "upload-pill";
  dom.contentEditable = "false";
  dom.setAttribute("role", "progressbar");
  dom.setAttribute("aria-label", `Uploading ${name}`);
  dom.setAttribute("aria-valuemin", "0");
  dom.setAttribute("aria-valuemax", "100");
  dom.setAttribute("aria-valuenow", "0");
  const label = document.createElement("span");
  label.className = "upload-pill-name";
  label.textContent = name;
  const track = document.createElement("span");
  track.className = "upload-pill-track";
  const bar = document.createElement("span");
  bar.className = "upload-pill-bar";
  track.append(bar);
  dom.append(label, track);
  return {
    dom,
    setProgress: (fraction) => {
      const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
      bar.style.width = `${percent}%`;
      dom.setAttribute("aria-valuenow", String(percent));
    },
  };
}

function TrashIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" />
    </svg>
  );
}

function AttachIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
    </svg>
  );
}

const HEADING_LEVELS = [1, 2, 3] as const;

function Toolbar({
  editor,
  compact,
  status,
  onAttach,
}: {
  editor: Editor | null;
  compact: boolean;
  status: string | null;
  onAttach: (files: File[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
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
        // 0 for normal text (or any other block).
        heading: HEADING_LEVELS.find((level) => e.isActive("heading", { level })) ?? 0,
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
      className={`sticky top-0 z-10 flex print:hidden flex-wrap items-center gap-0.5 border-b border-border-default bg-background ${
        compact ? "rounded-t-md px-1 py-1" : "-mx-2 min-h-11 px-2 py-1.5"
      }`}
    >
      <select
        aria-label="Text format"
        title="Text format"
        value={active.heading}
        disabled={off}
        onChange={(e) => {
          const level = Number(e.target.value);
          if (level === 0) chain().setParagraph().run();
          else chain().toggleHeading({ level: level as (typeof HEADING_LEVELS)[number] }).run();
        }}
        className="h-8 rounded bg-transparent px-1.5 text-[14px] text-text-secondary hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
      >
        <option value={0}>Normal text</option>
        {HEADING_LEVELS.map((level) => (
          <option key={level} value={level}>
            Heading {level}
          </option>
        ))}
      </select>
      <Divider />
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
        label="Attach file"
        on={false}
        disabled={off}
        onClick={() => fileInputRef.current?.click()}
      >
        <AttachIcon />
      </ToolButton>
      <input
        type="file"
        multiple
        className="hidden"
        ref={fileInputRef}
        onChange={(e) => {
          if (e.target.files?.length) {
            onAttach(Array.from(e.target.files));
            e.target.value = "";
          }
        }}
      />
      <ToolButton
        label="Insert whiteboard"
        on={false}
        disabled={off}
        onClick={() => chain().insertContent({ type: "whiteboard", attrs: { data: EMPTY_WHITEBOARD_JSON } }).run()}
      >
        <WhiteboardIcon />
      </ToolButton>
      <ToolButton
        label="Insert listen widget (record and transcribe a meeting)"
        on={false}
        disabled={off}
        onClick={() => chain().insertContent({ type: "listen", attrs: { data: newListenJson() } }).run()}
      >
        <MicIcon />
      </ToolButton>
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
          <span className="mr-1 font-mono text-[13px] uppercase tracking-[0.06em] text-accent-soft">Table</span>
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
      className={`flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-[15px] disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

type HeadingLevel = 0 | (typeof HEADING_LEVELS)[number];

const HEADING_OPTIONS: { level: HeadingLevel; name: string; tag: string }[] = [
  { level: 0, name: "Normal text", tag: "T" },
  ...HEADING_LEVELS.map((level) => ({ level, name: `Heading ${level}`, tag: `H${level}` })),
];

/**
 * The block type as one compact control, for the selection menu: the current type's tag (`T`, `H1`…) opening a list
 * of them all. Like ToolButton, it keeps the editor's selection while it's clicked.
 */
function HeadingDropdown({
  heading,
  disabled = false,
  onSelect,
}: {
  heading: HeadingLevel;
  disabled?: boolean;
  onSelect: (level: HeadingLevel) => void;
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
  const current = HEADING_OPTIONS.find((option) => option.level === heading) ?? HEADING_OPTIONS[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="Text format"
        aria-label={`Text format: ${current.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 min-w-8 items-center justify-center gap-0.5 rounded px-1.5 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
        }`}
      >
        {current.tag}
        <span aria-hidden className="text-[10px] opacity-70">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Text format"
          className="absolute left-0 top-full z-20 mt-1 flex w-40 flex-col rounded-md border border-border-default bg-surface-raised p-1 shadow-lg"
        >
          {HEADING_OPTIONS.map((option) => (
            <button
              key={option.level}
              type="button"
              role="option"
              aria-selected={option.level === heading}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(option.level);
                setOpen(false);
              }}
              className={`flex h-8 items-center gap-2 rounded px-2 text-left text-[14px] ${
                option.level === heading ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              }`}
            >
              <span className="w-6 text-[12px] font-semibold text-text-muted">{option.tag}</span>
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
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
  custom = true,
  onPick,
  children,
}: {
  label: string;
  colors: { name: string; value: string }[];
  color: string | null;
  disabled: boolean;
  /** Whether to offer a custom color picker beside the swatches. */
  custom?: boolean;
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
            {custom && (
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
            )}
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
