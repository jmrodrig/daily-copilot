import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { formatDay, LABEL_TAG, NEUTRAL_TAG, ProjectTag, Tag, TagPills } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { useSpace } from "../lib/space";
import { useTitle } from "../lib/title";
import { isOverdue, STATUS_LABELS, taskIdFromHref, useTaskChanges, useTaskPanel, type TaskItem } from "../lib/tasks";
import MediaLightbox, { ExpandButton, isPdfUrl, MarkupOverlay } from "../components/MediaLightbox";
import { isTyping } from "../components/markupCore";
import NoteEditor from "../components/NoteEditor";
import { PillIcon, refKind, StatusTag, useTaskStatus } from "../components/referencePill";
import { NOTE_COLUMN, NOTE_HTML_SCHEMA, layoutMedia, liftCellColors } from "../components/noteFormatting";
import WhiteboardView from "../components/WhiteboardView";
import { WhiteboardFrame } from "../components/WhiteboardWidget";

// GET /api/notes/file (see NoteFile in backend/schemas.py).
type NoteFile = { path: string; frontmatter: Record<string, unknown>; content: string };
type State = { state: "loading" } | { state: "ok"; note: NoteFile } | { state: "error"; message: string };
// The `state` front-matter: drafts are edited here, published notes are read-only. Notes without it are published.
type NoteState = "draft" | "published";

const noteState = (frontmatter: Record<string, unknown>): NoteState =>
  frontmatter.state === "draft" ? "draft" : "published";

/** A `type: whiteboard` note is a whiteboard page: its body is the board's JSON (see whiteboard.ts), not markdown. */
const isWhiteboardNote = (frontmatter: Record<string, unknown>) => frontmatter.type === "whiteboard";

// Front-matter keys that aren't listed: the title is the heading, the tags are pills in the header, and
// priorities belong to tasks, not notes. (A whiteboard's `type` isn't listed either: it shows in how it's laid out.)
const HIDDEN_PROPS = new Set(["title", "tags", "priority"]);

// A draft is saved once it's been left alone this long (ms).
const AUTO_SAVE_DELAY = 2000;

/** The note's `title` front-matter, or else its file name. */
const noteTitle = (frontmatter: Record<string, unknown>, path: string): string =>
  typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : (path.split("/").pop() ?? "").replace(/\.md$/i, "");

/** The `tags` front-matter, a list or a single tag, without blanks or repeats. */
const noteTags = (frontmatter: Record<string, unknown>): string[] => {
  const raw = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
  return [...new Set(raw.filter((t) => typeof t === "string" || typeof t === "number").map((t) => String(t).trim()))].filter(Boolean);
};

function show(value: unknown): string {
  // ISO timestamps (`2026-10-02T22:46:19`) read as `2026-10-02 22:46`.
  if (typeof value === "string") return value.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, "$1 $2");
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * A note or template (`/note?space=1&path=...[&root=templates]`). A draft note is edited in place, saved as it's
 * edited, and published when done; a published note (and a template) is read-only here, so click Edit or ask the
 * Co-pilot to change it. A whiteboard note (`type: whiteboard`) fills the page with its board instead of a document,
 * drawn on while it's a draft and read-only once published, saved the same way.
 */
export default function NotePage() {
  const [params] = useSearchParams();
  const { spaceId: activeSpaceId, refreshTree } = useSpace();
  const path = params.get("path") ?? "";
  const spaceId = Number(params.get("space") ?? activeSpaceId);
  const isTemplate = params.get("root") === "templates";
  const [note, setNote] = useState<State>({ state: "loading" });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [body, setBody] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  // An auto-save or Ctrl+S ("content") keeps the draft editable; publishing or editing a note ("state") doesn't.
  const [saving, setSaving] = useState<"content" | "state" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Tags are saved on their own, straight away; the body's auto-save waits for them.
  const [savingTags, setSavingTags] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  // The title and body that last failed to save: auto-save waits for another edit rather than retrying them.
  const failedRef = useRef<string | null>(null);
  // The draft's unsaved changes, saved when the page moves to another note (or closes) before auto-save has.
  const unsavedRef = useRef<{ space_id: number; path: string; content: string; title?: string } | null>(null);

  const parts = path.split("/");
  const fm = note.state === "ok" ? note.note.frontmatter : {};
  const title = noteTitle(fm, path);
  useTitle(title);
  // The edited title, saved to the `title` front-matter; a blank one is ignored.
  const newTitle = titleDraft.trim() !== (fm.title || '') ? titleDraft.trim() : null;
  const props = Object.entries(fm).filter(
    ([key, value]) =>
      !HIDDEN_PROPS.has(key) &&
      !(key === "state" && !isTemplate) &&
      !(key === "type" && value === "whiteboard") &&
      value !== null &&
      value !== "",
  );
  const state = isTemplate || note.state !== "ok" ? null : noteState(fm);
  const dirty = note.state === "ok" && (body !== note.note.content || newTitle !== null);
  const draftKey = `${titleDraft}\n${body}`;

  // Declared before the loading effect, which clears it for the next note.
  useEffect(() => {
    unsavedRef.current =
      state === "draft" && dirty ? { space_id: spaceId, path, content: body, ...(newTitle !== null && { title: newTitle }) } : null;
  });

  useEffect(() => {
    const controller = new AbortController();
    unsavedRef.current = null;
    setNote({ state: "loading" });
    setSaveError(null);
    setTagError(null);
    failedRef.current = null;
    const query = new URLSearchParams({ space_id: String(spaceId), path, root: isTemplate ? "templates" : "content" });
    getJson<NoteFile>(`/api/notes/file?${query}`, controller.signal)
      .then((loaded) => {
        setNote({ state: "ok", note: loaded });
        setBody(loaded.content);
        setTitleDraft(noteTitle(loaded.frontmatter, path));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setNote({ state: "error", message: message(err) });
      });
    return () => {
      controller.abort();
      // Leaving the note: keep the edits auto-save hasn't got to yet.
      const unsaved = unsavedRef.current;
      unsavedRef.current = null;
      if (unsaved) sendJson("PUT", "/api/notes/file", unsaved).then(refreshTree, () => {});
    };
  }, [path, spaceId, isTemplate]);

  useEffect(() => {
    setTasks([]);
    if (isTemplate) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ space_id: String(spaceId), note_path: path });
    getJson<TaskItem[]>(`/api/tasks?${query}`, controller.signal)
      .then(setTasks)
      .catch(() => {});
    return () => controller.abort();
  }, [path, spaceId, isTemplate]);

  // Edited in the task panel: update the linked tasks, dropping one that was deleted or linked elsewhere.
  useTaskChanges("board", ({ id, task, deleted }) =>
    setTasks((current) =>
      current.flatMap((t) => (t.id !== id ? [t] : deleted || (task && task.note_path !== path) ? [] : [task ?? t])),
    ),
  );

  // Auto-save: a draft is saved once it's been left alone for a moment. Each edit restarts the wait.
  useEffect(() => {
    if (state !== "draft" || !dirty || saving || savingTags || failedRef.current === draftKey) return;
    const timer = window.setTimeout(() => void save(), AUTO_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [state, dirty, saving, savingTags, draftKey]);

  // The latest `save`, for the key handler.
  const saveRef = useRef(save);
  saveRef.current = save;
  // "e" edits a published note. Not while typing, or with a dialog (the lightbox) open over it.
  useEffect(() => {
    if (state !== "published") return;
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== "e" || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
      if (isTyping(e.target) || document.querySelector("[aria-modal]")) return;
      e.preventDefault();
      void saveRef.current("draft");
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [state]);

  /** Save the draft's title and body and/or switch the note's state (PUT /api/notes/file). */
  async function save(next?: NoteState) {
    if (note.state !== "ok" || saving || savingTags) return;
    const content = body;
    const draft = titleDraft;
    setSaving(next ? "state" : "content");
    setSaveError(null);
    failedRef.current = null;
    try {
      const saved = await sendJson<NoteFile>("PUT", "/api/notes/file", {
        space_id: spaceId,
        path,
        ...(state === "draft" && { content }),
        ...(state === "draft" && newTitle !== null && { title: newTitle }),
        ...(next && { state: next }),
      });
      setNote({ state: "ok", note: saved });
      // Edits made while it saved are kept, for the next save.
      setBody((current) => (current === content ? saved.content : current));
      setTitleDraft((current) => (current === draft ? noteTitle(saved.frontmatter, path) : current));
      refreshTree(); // the title may have changed
    } catch (err) {
      failedRef.current = `${draft}\n${content}`;
      setSaveError(message(err));
    } finally {
      setSaving(null);
    }
  }

  /** Replace the note's `tags` front-matter (PUT /api/notes/file), leaving its body and unsaved edits alone. */
  async function saveTags(tags: string[]) {
    if (note.state !== "ok" || saving || savingTags) return;
    setSavingTags(true);
    setTagError(null);
    try {
      const saved = await sendJson<NoteFile>("PUT", "/api/notes/file", { space_id: spaceId, path, tags });
      // Only the front-matter changed on disk: the last saved body stays the baseline for unsaved edits.
      setNote((current) =>
        current.state === "ok" && current.note.path === saved.path
          ? { state: "ok", note: { ...current.note, frontmatter: saved.frontmatter } }
          : current,
      );
    } catch (err) {
      setTagError(message(err));
    } finally {
      setSavingTags(false);
    }
  }

  const status =
    state === "draft" ? (
      <div className="flex items-center gap-3">
        {saveError && !saving ? (
          <button type="button" className="btn" onClick={() => save()}>
            Retry save
          </button>
        ) : (
          <span role="status" className="text-xs text-text-muted">
            {saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
          </span>
        )}
        <button type="button" className="btn-primary" onClick={() => save("published")} disabled={saving !== null}>
          Publish
        </button>
      </div>
    ) : state === "published" ? (
      <button type="button" className="btn-primary" onClick={() => save("draft")} disabled={saving !== null}>
        Edit
      </button>
    ) : undefined;
  const whiteboard = note.state === "ok" && isWhiteboardNote(fm);
  // Printing (or saving as PDF from the print dialog) shows just the note; see the print styles in index.css.
  const actions = (
    <div className="flex items-center gap-3 print:hidden">
      {status}
      {!whiteboard && (
        <button type="button" className="btn" onClick={() => window.print()} disabled={note.state !== "ok"}>
          Print / PDF
        </button>
      )}
    </div>
  );

  const tags = noteTags(fm);
  // A note's tags can always be edited, drafts and published notes alike; a template's are only shown.
  const tagsEditable = state !== null;
  const details =
    props.length > 0 || tasks.length > 0 || tags.length > 0 || tagsEditable ? (
      <>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          {props.length > 0 && (
            <dl className="contents">
              {props.map(([key, value]) => (
                <div key={key} className="flex gap-1.5">
                  <dt className="text-text-muted">{key}</dt>
                  <dd className="text-text-secondary">{show(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {tagsEditable ? (
            <NoteTags spaceId={spaceId} tags={tags} onChange={saveTags} disabled={saving !== null || savingTags} />
          ) : (
            tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <TagPills tags={tags} />
              </div>
            )
          )}
        </div>
        {tagError && <p className="-mt-3 print:hidden text-[15px] text-accent">Could not update the tags ({tagError}).</p>}
        {tasks.length > 0 && <LinkedTasks tasks={tasks} />}
      </>
    ) : null;

  const breadcrumb = (
    <div className="flex min-w-0 items-center gap-3">
      <span className="truncate font-mono text-xs tracking-[0.06em] text-text-muted">
        {isTemplate ? "TEMPLATE" : parts.slice(0, -1).join(" / ").toUpperCase() || "NOTES"}
      </span>
      {whiteboard && <Tag className={NEUTRAL_TAG}>whiteboard</Tag>}
      {state && <Tag className={state === "draft" ? DRAFT_TAG : NEUTRAL_TAG}>{state}</Tag>}
    </div>
  );

  if (whiteboard && note.state === "ok") {
    const editable = state === "draft" && saving !== "state";
    return (
      // The board takes the rest of the page's height, under the title, the actions and the properties.
      <div className="flex h-full min-h-[560px] w-full flex-col gap-3 px-9 py-5">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-4">
          {breadcrumb}
          {actions}
        </div>
        {saveError && <p className="text-[15px] text-accent">Could not save {path} ({saveError}).</p>}
        {state === "draft" ? (
          <input
            aria-label="Title"
            placeholder="Untitled"
            value={titleDraft}
            disabled={!editable}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (dirty) void save();
              }
            }}
            className="w-full bg-transparent text-[26px] font-semibold leading-tight text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        ) : (
          <h1 className="text-[26px] font-semibold leading-tight">{title}</h1>
        )}
        {details && <div className="flex flex-col gap-3">{details}</div>}
        <WhiteboardView
          key={path}
          value={body}
          onChange={setBody}
          editable={editable}
          spaceId={spaceId}
          captureWheel
          onSave={() => dirty && void save()}
          className="min-h-[360px] flex-1 rounded-lg border border-border-default"
        />
      </div>
    );
  }

  return (
    // The page fills the canvas, so the editor's toolbar spans it; the note sits in a centered text column, out of
    // which resized images and tables can break.
    <div className="flex w-full flex-col gap-5 px-9 py-7 print:gap-4 print:p-0">
      {/* Breadcrumb and actions sit above the document, so the title reads as its first line. */}
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-4 print:hidden">
        {breadcrumb}
        {actions}
      </div>
      {saveError && <p className={`${NOTE_COLUMN} text-[15px] print:hidden text-accent`}>Could not save {path} ({saveError}).</p>}
      {state === "draft" && note.state === "ok" ? (
        // The editor's toolbar sits above the title, which is edited in place, and the properties.
        <NoteEditor
          key={path}
          spaceId={spaceId}
          notePath={path}
          onTaskCreated={(task) => task.note_path === path && setTasks((current) => [...current, task])}
          title={titleDraft}
          onTitleChange={setTitleDraft}
          value={body}
          onChange={setBody}
          onSave={() => dirty && save()}
          disabled={saving === "state"}
        >
          {details}
        </NoteEditor>
      ) : (
        <>
          <h1 className={`${NOTE_COLUMN} -mb-2 text-[33px] font-semibold leading-tight`}>{title}</h1>
          {note.state === "loading" && <p className={`${NOTE_COLUMN} text-[15px] text-text-muted`}>Loading…</p>}
          {note.state === "error" && <p className={`${NOTE_COLUMN} text-[15px] text-text-secondary`}>Could not open {path} ({note.message}).</p>}
          {note.state === "ok" && (
            <>
              {details && <div className={`${NOTE_COLUMN} flex flex-col gap-5`}>{details}</div>}
              <article className="note-body markdown text-[16px] leading-relaxed text-text-secondary">
                {/* Inline HTML carries text and cell colors, alignment and image and table sizes; anything else in it is stripped. */}
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, NOTE_HTML_SCHEMA], liftCellColors, layoutMedia]}
                  components={NOTE_COMPONENTS}
                >
                  {note.note.content}
                </Markdown>
              </article>
            </>
          )}
        </>
      )}
    </div>
  );
}

const DRAFT_TAG = "border-accent/60 text-accent";

/**
 * A note's tags as `#tag` pills (project codes in their project's color): hovering a pill shows an × that removes
 * it, and "+ Add tag" opens an inline input (Enter adds, Escape closes). While typing, a dropdown suggests the
 * space's existing tags (arrows move through it, Enter picks the highlighted one). Each change is saved through
 * `onChange`.
 */
function NoteTags({
  spaceId,
  tags,
  onChange,
  disabled,
}: {
  spaceId: number;
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
}) {
  const { projects } = useSpace();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  // The highlighted suggestion, or -1 for none (Enter then adds the typed tag).
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!adding) return;
    const controller = new AbortController();
    getJson<string[]>(`/api/spaces/${spaceId}/tags`, controller.signal)
      .then(setKnown)
      .catch(() => {}); // Suggestions are a convenience; typing a tag still works without them.
    return () => controller.abort();
  }, [adding, spaceId]);

  const query = draft.trim().replace(/^#+/, "").trim().toLowerCase();
  const taken = new Set(tags.map((t) => t.toLowerCase()));
  const suggestions = query ? known.filter((t) => !taken.has(t.toLowerCase()) && t.toLowerCase().includes(query)) : [];

  function add(tag = draft.trim().replace(/^#+/, "").trim()) {
    setDraft("");
    setActive(-1);
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
  }

  function tagStyle(tag: string) {
    const color = projects.find((p) => p.code.toLowerCase() === tag.toLowerCase())?.color;
    return color ? { className: "", style: { color, borderColor: `${color}99` } } : { className: LABEL_TAG };
  }

  return (
    <div role="group" aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => {
        const { className, style } = tagStyle(tag);
        return (
          <span
            key={tag}
            style={style}
            className={`group inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[12px] leading-4 ${className}`}
          >
            {`#${tag}`}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              title="Remove tag"
              disabled={disabled}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="hidden leading-none text-text-muted hover:text-accent focus-visible:inline group-hover:inline group-focus-within:inline disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}
      {adding ? (
        <div className="relative">
          <input
            autoFocus
            role="combobox"
            aria-label="New tag"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls="note-tag-suggestions"
            aria-activedescendant={active >= 0 ? `note-tag-suggestion-${active}` : undefined}
            placeholder="tag"
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && suggestions.length > 0) {
                e.preventDefault();
                setActive((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                e.preventDefault();
                setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                add(active >= 0 && active < suggestions.length ? suggestions[active] : undefined);
              } else if (e.key === "Escape") {
                setDraft("");
                setActive(-1);
                setAdding(false);
              }
            }}
            onBlur={() => {
              add();
              setAdding(false);
            }}
            className="w-28 rounded border border-border-default bg-transparent print:hidden px-1.5 py-px font-mono text-[12px] leading-4 text-text-primary outline-none focus:border-accent/60"
          />
          {suggestions.length > 0 && (
            <ul
              id="note-tag-suggestions"
              role="listbox"
              aria-label="Existing tags"
              className="absolute left-0 top-full z-20 mt-1 max-h-48 min-w-full overflow-y-auto rounded border border-border-strong bg-surface-active py-0.5 shadow-xl shadow-black/40 print:hidden"
            >
              {suggestions.map((tag, i) => (
                <li
                  key={tag}
                  id={`note-tag-suggestion-${i}`}
                  role="option"
                  aria-selected={i === active}
                  // Picked on mouse down, before the input's blur adds the half-typed draft instead.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(tag);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`cursor-pointer whitespace-nowrap px-2 py-0.5 font-mono text-[12px] leading-4 ${
                    i === active ? "bg-accent/15 text-accent" : "text-text-secondary"
                  }`}
                >
                  {`#${tag}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-border-default px-1.5 print:hidden py-px font-mono text-[12px] leading-4 text-text-muted hover:border-accent/60 hover:text-accent disabled:opacity-50"
        >
          + Add tag
        </button>
      )}
    </div>
  );
}

/**
 * A published note's image, in a box laid out as the image would be (taking its `note-media` class and width) with
 * its markup over it and an expand button on hover. Clicking it opens it fullscreen, read-only.
 */
function NoteImage({ node: _node, className, style, src, alt, title, ...props }: ComponentProps<"img"> & { node?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  // Counted up as the lightbox closes, so the markup's loaded again.
  const [opened, setOpened] = useState(0);
  if (!src) return <img alt={alt} title={title} {...props} />;
  return (
    <span className={`note-figure group ${className ?? ""}`} style={style}>
      <img src={src} alt={alt ?? ""} title={title} {...props} onClick={() => setExpanded(true)} className="cursor-zoom-in" />
      <MarkupOverlay src={src} version={opened} />
      <ExpandButton onClick={() => setExpanded(true)} />
      {title && <span className="mt-1.5 block text-center text-[14px] italic text-text-secondary">{title}</span>}
      {expanded && (
        <MediaLightbox
          src={src}
          alt={alt}
          title={title}
          onClose={() => {
            setExpanded(false);
            setOpened((n) => n + 1);
          }}
        />
      )}
    </span>
  );
}

const NOTE_COMPONENTS: Components = {
  img: NoteImage,
  // A ```whiteboard block (see noteFormatting) shows as its board, read-only; any other code block as code.
  pre: ({ node, ...props }) => {
    const code = node?.children[0];
    const classes = code?.type === "element" && code.tagName === "code" ? code.properties.className : null;
    if (code?.type === "element" && Array.isArray(classes) && classes.includes("language-whiteboard")) {
      const json = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
      return <WhiteboardFrame value={json.trim()} editable={false} />;
    }
    return <pre {...props} />;
  },
  a: ({ node: _node, ref, ...props }) => {
    // A task or note pill opens in the app, a URL pill in a new tab (see referencePill).
    const kind = refKind(props.title);
    if (kind === "task" && props.href) return <TaskPillLink href={props.href}>{props.children}</TaskPillLink>;
    if (kind && kind !== "url" && props.href)
      return (
        <Link to={props.href} className={`reference-pill ${kind}`}>
          <PillIcon kind={kind} />
          <span className="reference-pill-label">{props.children}</span>
        </Link>
      );
    if (kind)
      return (
        <a href={props.href} title={props.href} target="_blank" rel="noopener noreferrer" className="reference-pill url">
          <PillIcon kind="url" />
          <span className="reference-pill-label">{props.children}</span>
        </a>
      );
    if (props.href?.includes("/api/notes/image/") && isPdfUrl(props.href)) return <PdfLink href={props.href}>{props.children}</PdfLink>;
    return <a {...props} target={props.href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" />;
  },
};

/** A PDF attached to the read-only note: its pill opens it in the lightbox, read-only. */
function PdfLink({ href, children }: { href: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <>
      <a
        ref={ref}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          // Ctrl/Cmd-click still opens it in a new tab.
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && <MediaLightbox src={href} title={ref.current?.textContent || null} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A task pill in the read-only note: opens the task in the side panel, staying on the note. */
function TaskPillLink({ href, children }: { href: string; children: ReactNode }) {
  const { openTask } = useTaskPanel();
  const taskId = taskIdFromHref(href);
  const status = useTaskStatus(taskId);
  return (
    <Link
      to={href}
      className="reference-pill task"
      onClick={(e) => {
        // Ctrl/Cmd-click still opens the backlog in a new tab.
        if (taskId === null || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        openTask(taskId);
      }}
    >
      <PillIcon kind="task" />
      <span className="reference-pill-label">
        {status && <StatusTag status={status} />}
        {children}
      </span>
    </Link>
  );
}

function LinkedTasks({ tasks }: { tasks: TaskItem[] }) {
  const { taskId, openTask } = useTaskPanel();
  return (
    <section aria-label="Linked tasks" className="rounded-lg border border-border-default bg-surface-raised">
      <h2 className="flex items-center justify-between border-b border-border-default px-4 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
        <span>Linked tasks</span>
        <Link to="/tasks/backlog" className="print:hidden normal-case tracking-normal text-accent hover:underline">
          Backlog
        </Link>
      </h2>
      <ul className="divide-y divide-border-default/60">
        {tasks.map((task) => (
          <li key={task.id} className={`flex items-center gap-2 px-4 py-2 text-[15px] ${taskId === task.id ? "bg-surface-active" : ""}`}>
            <button
              type="button"
              onClick={() => openTask(task.id)}
              title="Open task details"
              className={`flex-1 truncate text-left hover:underline ${task.status === "done" ? "text-text-muted line-through" : "text-text-primary"}`}
            >
              {task.title}
            </button>
            {task.project_code && (
              <ProjectTag code={task.project_code} color={task.project_color} />
            )}
            <Tag className={NEUTRAL_TAG}>{STATUS_LABELS[task.status]}</Tag>
            {task.assignee && <span className="text-xs text-text-muted">👤 {task.assignee}</span>}
            {task.deadline && (
              <span className={`font-mono text-xs ${isOverdue(task) ? "text-accent" : "text-text-muted"}`}>
                {formatDay(task.deadline)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
