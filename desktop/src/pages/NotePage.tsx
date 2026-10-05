import { useEffect, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { formatDay, NEUTRAL_TAG, PROJECT_TAG, Tag } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { useSpace } from "../lib/space";
import { isOverdue, STATUS_LABELS, type TaskItem } from "../lib/tasks";
import ImageLightbox, { ExpandButton } from "../components/ImageLightbox";
import NoteEditor from "../components/NoteEditor";
import { NOTE_COLUMN, NOTE_HTML_SCHEMA, layoutMedia, liftCellColors } from "../components/noteFormatting";

// GET /api/notes/file (see NoteFile in backend/schemas.py).
type NoteFile = { path: string; frontmatter: Record<string, unknown>; content: string };
type State = { state: "loading" } | { state: "ok"; note: NoteFile } | { state: "error"; message: string };
// The `state` front-matter: drafts are edited here, published notes are read-only. Notes without it are published.
type NoteState = "draft" | "published";

const noteState = (frontmatter: Record<string, unknown>): NoteState =>
  frontmatter.state === "draft" ? "draft" : "published";

// Front-matter keys that aren't shown: the title is the heading, and priorities belong to tasks, not notes.
const HIDDEN_PROPS = new Set(["title", "priority"]);

// A draft is saved once it's been left alone this long (ms).
const AUTO_SAVE_DELAY = 2000;

/** The note's `title` front-matter, or else its file name. */
const noteTitle = (frontmatter: Record<string, unknown>, path: string): string =>
  typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : (path.split("/").pop() ?? "").replace(/\.md$/i, "");

function show(value: unknown): string {
  // ISO timestamps (`2026-10-02T22:46:19`) read as `2026-10-02 22:46`.
  if (typeof value === "string") return value.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, "$1 $2");
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * A note or template (`/note?space=1&path=...[&root=templates]`). A draft note is edited in place, saved as it's
 * edited, and published when done; a published note (and a template) is read-only here, so click Edit or ask the
 * Co-pilot to change it.
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
  // The title and body that last failed to save: auto-save waits for another edit rather than retrying them.
  const failedRef = useRef<string | null>(null);
  // The draft's unsaved changes, saved when the page moves to another note (or closes) before auto-save has.
  const unsavedRef = useRef<{ space_id: number; path: string; content: string; title?: string } | null>(null);

  const parts = path.split("/");
  const fm = note.state === "ok" ? note.note.frontmatter : {};
  const title = noteTitle(fm, path);
  // The edited title, saved to the `title` front-matter; a blank one is ignored.
  const newTitle = titleDraft.trim() && titleDraft.trim() !== title ? titleDraft.trim() : null;
  const props = Object.entries(fm).filter(
    ([key, value]) => !HIDDEN_PROPS.has(key) && !(key === "state" && !isTemplate) && value !== null && value !== "",
  );
  const state = isTemplate || note.state !== "ok" ? null : noteState(fm);
  const dirty = note.state === "ok" && (body !== note.note.content || newTitle !== null);
  const draftKey = `${titleDraft}\n${body}`;

  // Declared before the loading effect, which clears it for the next note.
  useEffect(() => {
    unsavedRef.current =
      state === "draft" && dirty ? { space_id: spaceId, path, content: body, ...(newTitle && { title: newTitle }) } : null;
  });

  useEffect(() => {
    const controller = new AbortController();
    unsavedRef.current = null;
    setNote({ state: "loading" });
    setSaveError(null);
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

  // Auto-save: a draft is saved once it's been left alone for a moment. Each edit restarts the wait.
  useEffect(() => {
    if (state !== "draft" || !dirty || saving || failedRef.current === draftKey) return;
    const timer = window.setTimeout(() => void save(), AUTO_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [state, dirty, saving, draftKey]);

  /** Save the draft's title and body and/or switch the note's state (PUT /api/notes/file). */
  async function save(next?: NoteState) {
    if (note.state !== "ok" || saving) return;
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
        ...(state === "draft" && newTitle && { title: newTitle }),
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

  const actions =
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

  const details =
    props.length > 0 || tasks.length > 0 ? (
      <>
        {props.length > 0 && (
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {props.map(([key, value]) => (
              <div key={key} className="flex gap-1.5">
                <dt className="text-text-muted">{key}</dt>
                <dd className="text-text-secondary">{show(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {tasks.length > 0 && <LinkedTasks tasks={tasks} />}
      </>
    ) : null;

  return (
    // The page fills the canvas, so the editor's toolbar spans it; the note sits in a centered text column, out of
    // which resized images and tables can break.
    <div className="flex w-full flex-col gap-5 px-9 py-7">
      {/* Breadcrumb and actions sit above the document, so the title reads as its first line. */}
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-mono text-xs tracking-[0.06em] text-text-muted">
            {isTemplate ? "TEMPLATE" : parts.slice(0, -1).join(" / ").toUpperCase() || "NOTES"}
          </span>
          {state && <Tag className={state === "draft" ? DRAFT_TAG : NEUTRAL_TAG}>{state}</Tag>}
        </div>
        {actions}
      </div>
      {saveError && <p className={`${NOTE_COLUMN} text-[13px] text-accent`}>Could not save {path} ({saveError}).</p>}
      {state === "draft" && note.state === "ok" ? (
        // The editor's toolbar sits above the title, which is edited in place, and the properties.
        <NoteEditor
          key={path}
          spaceId={spaceId}
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
          <h1 className={`${NOTE_COLUMN} -mb-2 text-[32px] font-semibold leading-tight`}>{title}</h1>
          {note.state === "loading" && <p className={`${NOTE_COLUMN} text-[13px] text-text-muted`}>Loading…</p>}
          {note.state === "error" && <p className={`${NOTE_COLUMN} text-[13px] text-text-secondary`}>Could not open {path} ({note.message}).</p>}
          {note.state === "ok" && (
            <>
              {details && <div className={`${NOTE_COLUMN} flex flex-col gap-5`}>{details}</div>}
              <article className="note-body markdown text-sm leading-relaxed text-text-secondary">
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
 * A published note's image, in a box laid out as the image would be (taking its `note-media` class and width) with
 * an expand button on hover. Clicking it opens it fullscreen, read-only.
 */
function NoteImage({ node: _node, className, style, src, alt, title, ...props }: ComponentProps<"img"> & { node?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (!src) return <img alt={alt} title={title} {...props} />;
  return (
    <span className={`note-figure group ${className ?? ""}`} style={style}>
      <img src={src} alt={alt ?? ""} title={title} {...props} onClick={() => setExpanded(true)} className="cursor-zoom-in" />
      <ExpandButton onClick={() => setExpanded(true)} />
      {expanded && <ImageLightbox src={src} alt={alt} title={title} onClose={() => setExpanded(false)} />}
    </span>
  );
}

const NOTE_COMPONENTS: Components = { img: NoteImage };

function LinkedTasks({ tasks }: { tasks: TaskItem[] }) {
  return (
    <section aria-label="Linked tasks" className="rounded-lg border border-border-default bg-surface-raised">
      <h2 className="flex items-center justify-between border-b border-border-default px-4 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
        <span>Linked tasks</span>
        <Link to="/tasks/backlog" className="normal-case tracking-normal text-accent hover:underline">
          Backlog
        </Link>
      </h2>
      <ul className="divide-y divide-border-default/60">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
            <span className={`flex-1 truncate ${task.status === "done" ? "text-text-muted line-through" : "text-text-primary"}`}>
              {task.title}
            </span>
            {task.project_code && (
              <Tag className={PROJECT_TAG[task.project_code.toLowerCase()] ?? NEUTRAL_TAG}>{task.project_code}</Tag>
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
