import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";

import { getJson, message, sendJson } from "../lib/api";
import { notePath } from "../lib/space";
import {
  announceTaskChange,
  isOverdue,
  STATUS_LABELS,
  useTaskChanges,
  type TaskComment,
  type TaskItem,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "../lib/tasks";
import { ME, NEUTRAL_TAG, PROJECT_TAG, Tag, TagPills } from "./TriageBoard";

type State = { state: "loading" } | { state: "ok"; task: TaskItem } | { state: "error"; message: string };

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
// Text fields save on their own once typing pauses for this long, so the task's pills follow along.
const AUTO_SAVE_DELAY = 500;

/** The task open in the right-hand panel (`?taskId=`): its fields, description and comments, all editable. */
export default function TaskPanel({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // A save can finish after another task was opened (blurring a field by clicking a card): don't show it then.
  const shownId = useRef(taskId);
  shownId.current = taskId;

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => (prev.state === "ok" && prev.task.id === taskId ? prev : { state: "loading" }));
    setError(null);
    getJson<TaskItem>(`/api/tasks/${taskId}`, controller.signal)
      .then((task) => setState({ state: "ok", task }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [taskId, reload]);

  // Changed on the board (dragged, renamed, deleted): show the server's copy.
  useTaskChanges("panel", (change) => {
    if (change.id !== taskId) return;
    if (change.deleted) onClose();
    else setReload((n) => n + 1);
  });

  /** Save a change, then show and announce the server's copy of the task (a PATCH answers with the bare row). */
  async function save(request: () => Promise<unknown>, what: string) {
    setError(null);
    try {
      await request();
      const fresh = await getJson<TaskItem>(`/api/tasks/${taskId}`);
      if (shownId.current === taskId) setState({ state: "ok", task: fresh });
      announceTaskChange({ id: taskId, task: fresh, source: "panel" });
      return true;
    } catch (err: unknown) {
      if (shownId.current === taskId) setError(`Could not ${what}: ${message(err)}`);
      return false;
    }
  }

  const patch = (body: TaskPatch) => save(() => sendJson("PATCH", `/api/tasks/${taskId}`, body), "save the task");

  async function remove(task: TaskItem) {
    if (!window.confirm(`Delete "${task.title}"? It stays in the version history.`)) return;
    try {
      await sendJson("DELETE", `/api/tasks/${taskId}`);
      announceTaskChange({ id: taskId, deleted: true, source: "panel" });
      onClose();
    } catch (err: unknown) {
      setError(`Could not delete the task: ${message(err)}`);
    }
  }

  return (
    <section aria-label="Task details" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2 pl-5 pr-3 pt-3.5">
        <span className="font-mono text-[13px] uppercase tracking-wider text-text-muted">Task #{taskId}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task"
          title="Close task"
          className="flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none text-text-muted hover:bg-surface-raised hover:text-text-primary"
        >
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
        {state.state === "loading" && <p className="text-[15px] text-text-muted">Loading the task…</p>}
        {state.state === "error" && <p className="text-[15px] text-text-secondary">Could not load the task ({state.message}).</p>}
        {state.state === "ok" && (
          <TaskFields key={state.task.id} task={state.task} onPatch={patch} onSave={save} onDelete={() => remove(state.task)} />
        )}
        {error && <p className="text-xs text-accent">{error}</p>}
      </div>
    </section>
  );
}

function TaskFields({
  task,
  onPatch,
  onSave,
  onDelete,
}: {
  task: TaskItem;
  onPatch: (patch: TaskPatch) => Promise<boolean>;
  onSave: (request: () => Promise<unknown>, what: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const label = "flex flex-col gap-1 text-[13px] text-text-muted";
  const overdue = isOverdue(task);
  return (
    <>
      <div className="flex flex-col gap-2">
        <TextField
          ariaLabel="Title"
          value={task.title}
          required
          multiline
          onSave={(title) => onPatch({ title })}
          className="block w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold leading-snug text-text-primary hover:border-border-default focus:border-accent/70 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <Tag className={(task.project_code && PROJECT_TAG[task.project_code.toLowerCase()]) || NEUTRAL_TAG}>
            {task.project_code ?? "No project"}
          </Tag>
          {task.is_gantt_task && <Tag className={NEUTRAL_TAG}>gantt</Tag>}
          {task.is_milestone && <Tag className="border-accent/60 text-accent">milestone</Tag>}
          {overdue && <Tag className="border-accent bg-accent/15 text-accent">overdue</Tag>}
          <TagPills tags={task.tags} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <label className={label}>
          Status
          <select value={task.status} onChange={(e) => onPatch({ status: e.target.value as TaskStatus })} className="field py-1.5 text-[15px]">
            {Object.entries(STATUS_LABELS).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Priority
          <select value={task.priority} onChange={(e) => onPatch({ priority: e.target.value as TaskPriority })} className="field py-1.5 text-[15px] capitalize">
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Start
          <input
            type="date"
            value={task.start_date ?? ""}
            onChange={(e) => onPatch({ start_date: e.target.value || null })}
            className={`field py-1.5 text-[15px] ${task.start_date ? "text-text-primary" : "text-text-muted"}`}
          />
        </label>
        <label className={label}>
          Due
          <input
            type="date"
            value={task.deadline ?? ""}
            onChange={(e) => onPatch({ deadline: e.target.value || null })}
            className={`field py-1.5 text-[15px] ${task.deadline ? "text-text-primary" : "text-text-muted"} ${overdue ? "!text-accent" : ""}`}
          />
        </label>
        <label className={`${label} col-span-2`}>
          Assignee
          <TextField
            ariaLabel="Assignee"
            value={task.assignee ?? ""}
            placeholder="Unassigned"
            onSave={(value) => onPatch({ assignee: value.trim() || null })}
            className="field py-1.5 text-[15px]"
          />
        </label>
      </div>

      <LinkedNote task={task} onPatch={onPatch} />

      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-text-muted">Description</span>
        <DescriptionField task={task} onPatch={onPatch} />
      </div>

      <Comments task={task} onSave={onSave} />

      <button type="button" className="self-start text-xs text-text-muted hover:text-accent" onClick={onDelete}>
        Delete task
      </button>
    </>
  );
}

/**
 * A single-value field saved shortly after typing stops, and on blur or Enter; Escape puts the saved value back.
 * `multiline` wraps long text in a textarea that grows to fit (Enter still saves rather than adding a line).
 */
function TextField({
  value,
  onSave,
  ariaLabel,
  placeholder,
  required,
  multiline,
  className,
}: {
  value: string;
  onSave: (value: string) => Promise<boolean>;
  ariaLabel: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  className: string;
}) {
  const [draft, setDraft] = useState(value);
  // The value an auto-save sent: when it comes back as `value`, the draft (maybe typed further since) is kept.
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    if (value !== sentRef.current) setDraft(value);
    sentRef.current = null;
  }, [value]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, multiline]);

  async function commit() {
    const trimmed = draft.replace(/\s+/g, " ").trim();
    if (trimmed === value.trim()) {
      if (draft !== trimmed) setDraft(trimmed);
      return;
    }
    if (required && !trimmed) return setDraft(value);
    if (!(await onSave(trimmed))) setDraft(value);
    else setDraft(trimmed);
  }

  // Auto-save leaves the draft as typed (a trailing space is the start of the next word); blur tidies it.
  useEffect(() => {
    const trimmed = draft.replace(/\s+/g, " ").trim();
    if (trimmed === value.trim() || (required && !trimmed)) return;
    const timer = window.setTimeout(async () => {
      sentRef.current = trimmed;
      if (!(await onSave(trimmed))) sentRef.current = null;
    }, AUTO_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [draft, value]);

  const props = {
    "aria-label": ariaLabel,
    value: draft,
    placeholder,
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      }
      if (e.key === "Escape") setDraft(value);
    },
  };

  return multiline ? (
    <textarea
      {...props}
      ref={textareaRef}
      rows={1}
      // A pasted line break would otherwise end up in the value: it's still one line of text.
      onChange={(e) => setDraft(e.target.value.replace(/\r?\n/g, " "))}
      className={`resize-none overflow-hidden ${className}`}
    />
  ) : (
    <input {...props} onChange={(e) => setDraft(e.target.value)} className={className} />
  );
}

/** Plain text, saved shortly after typing stops, and when the field loses focus (or on Ctrl+Enter). */
function DescriptionField({ task, onPatch }: { task: TaskItem; onPatch: (patch: TaskPatch) => Promise<boolean> }) {
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);
  // As in TextField: an auto-save coming back doesn't overwrite what was typed since.
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    if (task.description !== sentRef.current) setDraft(task.description);
    sentRef.current = null;
  }, [task.description]);
  const dirty = draft !== task.description;

  async function commit(auto = false) {
    if (!dirty) return;
    if (auto) sentRef.current = draft;
    setSaving(true);
    if (!(await onPatch({ description: draft }))) sentRef.current = null;
    setSaving(false);
  }

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void commit(true), AUTO_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [draft, task.description]);

  return (
    <>
      <textarea
        aria-label="Description"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.blur();
          if (e.key === "Escape") setDraft(task.description);
        }}
        rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
        placeholder="Add a description…"
        className="field resize-y py-2 text-[15px] leading-5"
      />
      <span className="h-4 text-[13px] text-text-muted">{saving ? "Saving…" : dirty ? "Unsaved" : ""}</span>
    </>
  );
}

function LinkedNote({ task, onPatch }: { task: TaskItem; onPatch: (patch: TaskPatch) => Promise<boolean> }) {
  const [allNotes, setAllNotes] = useState<{ path: string; title: string }[]>([]);
  const [link, setLink] = useState("");
  // The link field stays hidden until the pencil next to the label is clicked.
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getJson<{ path: string; title: string }[]>(`/api/notes?space_id=${task.space_id}`, controller.signal)
      .then(setAllNotes)
      .catch(() => {});
    return () => controller.abort();
  }, [task.space_id]);

  /** A task links to one note: linking another replaces it. */
  async function linkNote(event: FormEvent) {
    event.preventDefault();
    if (!link.trim()) return;
    if (await onPatch({ note_path: link.trim() })) {
      setLink("");
      setEditing(false);
    }
  }

  function cancel() {
    setLink("");
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="text-[13px] text-text-muted">Linked note</span>
        <button
          type="button"
          onClick={() => (editing ? cancel() : setEditing(true))}
          className={`rounded p-0.5 hover:text-accent ${editing ? "text-accent" : "text-text-muted"}`}
          aria-label={task.note_path ? "Change linked note" : "Link a note"}
          aria-expanded={editing}
          title={task.note_path ? "Change linked note" : "Link a note"}
        >
          <PencilIcon />
        </button>
      </span>
      {task.note_path && (
        <span className="flex min-w-0 items-center gap-2">
          <Link to={notePath(task.space_id, task.note_path)} className="truncate text-accent hover:underline" title={task.note_path}>
            {task.note_path}
          </Link>
          <button type="button" onClick={() => onPatch({ note_path: null })} className="text-text-muted hover:text-accent" aria-label={`Unlink ${task.note_path}`}>
            ×
          </button>
        </span>
      )}
      {editing && (
        <form onSubmit={linkNote} className="flex gap-1.5">
          <input
            autoFocus
            list={`panel-notes-${task.id}`}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
            }}
            placeholder={task.note_path ? "Link another note instead…" : "Link a note…"}
            className="field py-1 text-xs"
          />
          <datalist id={`panel-notes-${task.id}`}>
            {allNotes
              .filter((n) => n.path !== task.note_path)
              .map((n) => (
                <option key={n.path} value={n.path}>
                  {n.title}
                </option>
              ))}
          </datalist>
          <button type="submit" className="btn min-h-0 px-2 py-1 text-xs" disabled={!link.trim()}>
            Link
          </button>
        </form>
      )}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z" />
      <path d="M9.5 4l2.5 2.5" />
    </svg>
  );
}

// --- Comments ---------------------------------------------------------------------

function Comments({ task, onSave }: { task: TaskItem; onSave: (request: () => Promise<unknown>, what: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const base = `/api/tasks/${task.id}/comments`;

  async function post(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim() || posting) return;
    setPosting(true);
    if (await onSave(() => sendJson("POST", base, { text, author: ME }), "add the comment")) setText("");
    setPosting(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-text-muted">Comments ({task.comments.length})</span>
      {task.comments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {task.comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              onEdit={(next) => onSave(() => sendJson("PATCH", `${base}/${comment.id}`, { text: next }), "edit the comment")}
              onDelete={() => {
                if (window.confirm("Delete this comment?")) onSave(() => sendJson("DELETE", `${base}/${comment.id}`), "delete the comment");
              }}
            />
          ))}
        </ul>
      )}
      <form onSubmit={post} className="flex flex-col gap-1.5">
        <textarea
          aria-label="New comment"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post();
          }}
          rows={2}
          placeholder="Write a comment… (Ctrl+Enter to post)"
          className="field resize-y py-2 text-[15px] leading-5"
        />
        <button type="submit" className="btn-primary min-h-8 self-end px-3 text-xs" disabled={posting || !text.trim()}>
          {posting ? "Posting…" : "Comment"}
        </button>
      </form>
    </div>
  );
}

function CommentItem({ comment, onEdit, onDelete }: { comment: TaskComment; onEdit: (text: string) => Promise<boolean>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);

  async function commit() {
    if (!draft.trim()) return;
    if (draft.trim() === comment.text || (await onEdit(draft))) setEditing(false);
  }

  return (
    <li className="group rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-[15px]">
      <div className="flex items-baseline gap-2 text-[13px] text-text-muted">
        <span className="font-medium text-text-secondary">{comment.author ?? "Anonymous"}</span>
        <span title={comment.updated_at ? `Edited ${formatTime(comment.updated_at)}` : undefined}>
          {formatTime(comment.created_at)}
          {comment.updated_at && " · edited"}
        </span>
        {!editing && (
          <span className="ml-auto flex gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              className="hover:text-text-primary"
              onClick={() => {
                setDraft(comment.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button type="button" className="hover:text-accent" onClick={onDelete}>
              Delete
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <textarea
            aria-label="Edit comment"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
              if (e.key === "Escape") setEditing(false);
            }}
            rows={Math.max(2, draft.split("\n").length)}
            className="field resize-y py-1.5 text-[15px] leading-5"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn min-h-7 px-2.5 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary min-h-7 px-2.5 text-xs" disabled={!draft.trim()} onClick={commit}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">{comment.text}</p>
      )}
    </li>
  );
}

/** The backend stores naive UTC (see `utcnow`): read a time without a zone as UTC. */
function formatTime(iso: string): string {
  const utc = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  return new Date(utc).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
