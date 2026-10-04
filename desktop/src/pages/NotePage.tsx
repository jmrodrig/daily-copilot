import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import { formatDay, NEUTRAL_TAG, PROJECT_TAG, Tag } from "../components/TriageBoard";
import { getJson, message } from "../lib/api";
import { useSpace } from "../lib/space";
import { isOverdue, STATUS_LABELS, type TaskItem } from "../lib/tasks";
import PageHeader from "../components/PageHeader";

// GET /api/notes/file (see NoteFile in backend/schemas.py).
type NoteFile = { path: string; frontmatter: Record<string, unknown>; content: string };
type State = { state: "loading" } | { state: "ok"; note: NoteFile } | { state: "error"; message: string };

function show(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A note or template, read-only; ask the Co-pilot to change it (`/note?space=1&path=...[&root=templates]`). */
export default function NotePage() {
  const [params] = useSearchParams();
  const { spaceId: activeSpaceId } = useSpace();
  const path = params.get("path") ?? "";
  const spaceId = Number(params.get("space") ?? activeSpaceId);
  const isTemplate = params.get("root") === "templates";
  const [note, setNote] = useState<State>({ state: "loading" });
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setNote({ state: "loading" });
    const query = new URLSearchParams({ space_id: String(spaceId), path, root: isTemplate ? "templates" : "content" });
    getJson<NoteFile>(`/api/notes/file?${query}`, controller.signal)
      .then((body) => setNote({ state: "ok", note: body }))
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
  const props = Object.entries(fm).filter(([key, value]) => key !== "title" && value !== null && value !== "");

  return (
    <div className="flex max-w-4xl flex-col gap-5 px-9 py-7">
      <PageHeader
        eyebrow={isTemplate ? "TEMPLATE" : parts.slice(0, -1).join(" / ").toUpperCase() || "NOTES"}
        title={title}
      />
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
          <article className="markdown text-sm leading-relaxed text-text-secondary">
            <Markdown remarkPlugins={[remarkGfm]}>{note.note.content}</Markdown>
          </article>
        </>
      )}
    </div>
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
