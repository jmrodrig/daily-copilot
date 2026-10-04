import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import { formatDay, NEUTRAL_TAG, PROJECT_TAG, Tag } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { useSpace } from "../lib/space";
import { isOverdue, STATUS_LABELS, type TaskItem } from "../lib/tasks";
import PageHeader from "../components/PageHeader";

// GET /api/notes/file (see NoteFile in backend/schemas.py).
type NoteFile = { path: string; frontmatter: Record<string, unknown>; content: string };
type State = { state: "loading" } | { state: "ok"; note: NoteFile } | { state: "error"; message: string };
// The `state` front-matter: drafts are edited here, published notes are read-only. Notes without it are published.
type NoteState = "draft" | "published";

const noteState = (frontmatter: Record<string, unknown>): NoteState =>
  frontmatter.state === "draft" ? "draft" : "published";

function show(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * A note or template (`/note?space=1&path=...[&root=templates]`). A draft note is edited in place and published
 * when done; a published note (and a template) is read-only here, so click Edit or ask the Co-pilot to change it.
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setNote({ state: "loading" });
    setSaveError(null);
    const query = new URLSearchParams({ space_id: String(spaceId), path, root: isTemplate ? "templates" : "content" });
    getJson<NoteFile>(`/api/notes/file?${query}`, controller.signal)
      .then((loaded) => {
        setNote({ state: "ok", note: loaded });
        setBody(loaded.content);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setNote({ state: "error", message: message(err) });
      });
    return () => controller.abort();
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

  const parts = path.split("/");
  const fm = note.state === "ok" ? note.note.frontmatter : {};
  const title = typeof fm.title === "string" && fm.title ? fm.title : parts[parts.length - 1].replace(/\.md$/i, "");
  const props = Object.entries(fm).filter(
    ([key, value]) => key !== "title" && !(key === "state" && !isTemplate) && value !== null && value !== "",
  );
  const state = isTemplate || note.state !== "ok" ? null : noteState(fm);
  const dirty = note.state === "ok" && body !== note.note.content;

  /** Save the draft's body and/or switch the note's state (PUT /api/notes/file). */
  async function save(next?: NoteState) {
    if (note.state !== "ok" || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await sendJson<NoteFile>("PUT", "/api/notes/file", {
        space_id: spaceId,
        path,
        ...(state === "draft" && { content: body }),
        ...(next && { state: next }),
      });
      setNote({ state: "ok", note: saved });
      setBody(saved.content);
      refreshTree(); // the title may have changed
    } catch (err) {
      setSaveError(message(err));
    } finally {
      setSaving(false);
    }
  }

  const actions =
    state === "draft" ? (
      <div className="flex items-center gap-2">
        <button type="button" className="btn" onClick={() => save()} disabled={saving || !dirty}>
          {dirty ? "Save draft" : "Saved"}
        </button>
        <button type="button" className="btn-primary" onClick={() => save("published")} disabled={saving}>
          Publish
        </button>
      </div>
    ) : state === "published" ? (
      <button type="button" className="btn-primary" onClick={() => save("draft")} disabled={saving}>
        Edit
      </button>
    ) : undefined;

  return (
    <div className="flex max-w-4xl flex-col gap-5 px-9 py-7">
      <PageHeader
        eyebrow={isTemplate ? "TEMPLATE" : parts.slice(0, -1).join(" / ").toUpperCase() || "NOTES"}
        title={title}
        badge={state && <Tag className={state === "draft" ? DRAFT_TAG : NEUTRAL_TAG}>{state}</Tag>}
        actions={actions}
      />
      {saveError && <p className="text-[13px] text-accent">Could not save {path} ({saveError}).</p>}
      {note.state === "loading" && <p className="text-[13px] text-text-muted">Loading…</p>}
      {note.state === "error" && <p className="text-[13px] text-text-secondary">Could not open {path} ({note.message}).</p>}
      {note.state === "ok" && (
        <>
          {props.length > 0 && (
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-b border-border-default pb-4 text-[13px]">
              {props.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-text-muted">{key}</dt>
                  <dd className="text-text-secondary">{show(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {tasks.length > 0 && <LinkedTasks tasks={tasks} />}
          {state === "draft" ? (
            <DraftEditor value={body} onChange={setBody} onSave={() => dirty && save()} disabled={saving} />
          ) : (
            <article className="markdown text-sm leading-relaxed text-text-secondary">
              <Markdown remarkPlugins={[remarkGfm]}>{note.note.content}</Markdown>
            </article>
          )}
        </>
      )}
    </div>
  );
}

const DRAFT_TAG = "border-accent/60 text-accent";

/** The draft's markdown body (front-matter is kept by the backend): grows with its text; Ctrl/Cmd+S saves. */
function DraftEditor({
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
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 2}px`;
  }, [value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
    }
  }

  return (
    <label>
      <span className="sr-only">Note body (markdown)</span>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        readOnly={disabled}
        spellCheck
        className="field block min-h-64 resize-none overflow-hidden font-mono text-[13px] leading-relaxed"
      />
    </label>
  );
}

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
