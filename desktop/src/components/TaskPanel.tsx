import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";

import { getJson, message, sendJson } from "../lib/api";
import { colouredOptions, optionColor, pillStyle } from "../lib/colors";
import { AssigneeSelect, usePeople, type Person } from "../lib/people";
import { notePath, useSpace, type CustomFieldDef } from "../lib/space";
import {
  allowedStatuses,
  announceTaskChange,
  createTaskLink,
  deleteTaskLink,
  fetchTaskDependencies,
  isOverdue,
  STATUS_LABELS,
  statusColor,
  useLinksChanged,
  useTaskChanges,
  useTaskPanel,
  type CustomFieldValue,
  type ProjectOption,
  type TaskComment,
  type TaskDependencies,
  type TaskItem,
  type TaskLinkItem,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "../lib/tasks";
import NoteEditor from "./NoteEditor";
import Popover from "./Popover";
import { postStatusComment, useStatusChangePrompt } from "./StatusChangeDialog";
import { OptionPill } from "./ColorPicker";
import { ProjectPicker } from "./ProjectPicker";
import { fetchUrlTitle, isWebUrl, linkPill, linkSegments, pastedLink, pillMarkdown, StaticPill } from "./referencePill";
import { ME, NEUTRAL_TAG, ProjectTag, Tag, TagPills } from "./TriageBoard";

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

  /** Asks for a comment explaining the change if the status flow wants one, then saves both (or nothing, if cancelled). */
  const { spaces } = useSpace();
  const { ask, dialog } = useStatusChangePrompt();
  async function changeStatus(task: TaskItem, to: TaskStatus) {
    if (to === task.status) return true;
    const answer = await ask(task, to, spaces.find((s) => s.id === task.space_id)?.status_flow);
    if (!answer) return false;
    return save(async () => {
      await sendJson("PATCH", `/api/tasks/${task.id}`, { status: to });
      if (answer.comment) await postStatusComment(task.id, task.status, to, answer.comment);
    }, "change the status");
  }

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
          <TaskFields
            key={state.task.id}
            task={state.task}
            onPatch={patch}
            onStatus={(to) => changeStatus(state.task, to)}
            onSave={save}
            onDelete={() => remove(state.task)}
          />
        )}
        {error && <p className="text-xs text-accent">{error}</p>}
      </div>
      {dialog}
    </section>
  );
}

/** The projects of a task's space: the active space's are already loaded, another space's are fetched. */
function useProjects(spaceId: number): ProjectOption[] {
  const { spaceId: activeId, projects: active } = useSpace();
  const [other, setOther] = useState<ProjectOption[]>([]);

  useEffect(() => {
    if (spaceId === activeId) return;
    const controller = new AbortController();
    getJson<ProjectOption[]>(`/api/projects?space_id=${spaceId}`, controller.signal)
      .then(setOther)
      .catch(() => {});
    return () => controller.abort();
  }, [spaceId, activeId]);

  return spaceId === activeId ? active : other;
}

function TaskFields({
  task,
  onPatch,
  onStatus,
  onSave,
  onDelete,
}: {
  task: TaskItem;
  onPatch: (patch: TaskPatch) => Promise<boolean>;
  onStatus: (status: TaskStatus) => Promise<boolean>;
  onSave: (request: () => Promise<unknown>, what: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const label = "flex flex-col gap-1 text-[13px] text-text-muted";
  const overdue = isOverdue(task);
  const space = useSpace().spaces.find((s) => s.id === task.space_id);
  const statuses = allowedStatuses(space?.status_flow, task.status);
  const customFields = space?.custom_fields_schema ?? [];
  const people = usePeople(task.space_id);
  const projects = useProjects(task.space_id);
  return (
    <>
      <div className="flex flex-col gap-2">
        <TextField
          ariaLabel="Title"
          value={task.title}
          required
          multiline
          onSave={(title) => onPatch({ title })}
          className="block w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xl font-semibold leading-snug text-text-primary hover:border-border-default focus:border-accent/70 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <ProjectTag code={task.project_code} color={task.project_color} />
          {task.is_gantt_task && <Tag className={NEUTRAL_TAG}>gantt</Tag>}
          {task.is_milestone && <Tag className="border-accent/60 text-accent">milestone</Tag>}
          {overdue && <Tag className="border-accent bg-accent/15 text-accent">overdue</Tag>}
          {colouredOptions(customFields, task.custom_fields).map(({ field }) => (
            <OptionPill key={field.id} field={field} value={task.custom_fields[field.id]} />
          ))}
          <TagPills tags={task.tags} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <label className={label}>
          Status
          <select
            value={task.status}
            onChange={(e) => onStatus(e.target.value as TaskStatus)}
            title={statuses.length < Object.keys(STATUS_LABELS).length ? "Limited by the space's status flow" : undefined}
            className="field py-1.5 text-[15px]"
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
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
          Project
          <ProjectPicker
            value={task.project_id}
            projects={projects}
            onChange={(project_id) => onPatch({ project_id })}
            className="field flex min-h-[38px] w-full items-center justify-between py-1.5 text-[15px]"
          />
        </label>
        <label className={`${label} col-span-2`}>
          Assignee
          <AssigneeSelect
            value={task.assignee}
            people={people}
            onChange={(assignee) => onPatch({ assignee })}
            className="field py-1.5 text-[15px]"
          />
        </label>
        {customFields.map((field) => (
          <CustomField
            key={field.id}
            field={field}
            value={task.custom_fields[field.id]}
            people={people}
            onSave={(value) => onPatch({ custom_fields: { [field.id]: value } })}
          />
        ))}
      </div>

      <LinkedNote task={task} onPatch={onPatch} />

      <Dependencies task={task} />

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
    const adjust = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    adjust();
    if (!multiline) return;
    let lastWidth = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth !== lastWidth) {
        lastWidth = el.offsetWidth;
        adjust();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
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

/** One of the space's custom fields (see Space preferences); an emptied field is cleared. */
function CustomField({
  field,
  value,
  people,
  onSave,
}: {
  field: CustomFieldDef;
  value: CustomFieldValue | undefined;
  people: Person[];
  onSave: (value: CustomFieldValue | null) => Promise<boolean>;
}) {
  const label = "flex flex-col gap-1 text-[13px] text-text-muted";
  const input = "field py-1.5 text-[15px]";
  switch (field.type) {
    case "checkbox":
      return (
        <label className="flex items-center gap-2 self-end py-1.5 text-[13px] text-text-muted">
          <input type="checkbox" checked={value === true} onChange={(e) => onSave(e.target.checked)} />
          {field.name}
        </label>
      );
    case "date":
      return (
        <label className={label}>
          {field.name}
          <input
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onSave(e.target.value || null)}
            className={`${input} ${value ? "text-text-primary" : "text-text-muted"}`}
          />
        </label>
      );
    case "dropdown": {
      const current = typeof value === "string" ? value : "";
      const color = optionColor(field, current);
      return (
        <label className={label}>
          {field.name}
          <select
            value={current}
            onChange={(e) => onSave(e.target.value || null)}
            // The chosen option's colour as a bar down the left edge.
            style={color ? { borderLeftColor: color, borderLeftWidth: 4 } : undefined}
            className={`${input} ${current ? "text-text-primary" : "text-text-muted"}`}
          >
            <option value="">—</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            {/* A value whose option was since removed from the field stays shown until changed. */}
            {current && !field.options.includes(current) && <option value={current}>{current}</option>}
          </select>
        </label>
      );
    }
    case "person":
      return (
        <label className={`${label} col-span-2`}>
          {field.name}
          <AssigneeSelect
            ariaLabel={field.name}
            value={typeof value === "string" ? value : null}
            people={people}
            emptyLabel="—"
            onChange={(name) => onSave(name)}
            className={input}
          />
        </label>
      );
    case "number":
      return (
        <label className={label}>
          {field.name}
          <NumberField ariaLabel={field.name} value={typeof value === "number" ? value : null} onSave={onSave} className={input} />
        </label>
      );
    default:
      return (
        <label className={`${label} col-span-2`}>
          {field.name}
          <TextField
            ariaLabel={field.name}
            value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
            placeholder="—"
            onSave={(text) => onSave(text.trim() || null)}
            className={input}
          />
        </label>
      );
  }
}

/** A number saved on blur or Enter; an empty field saves null, and text that isn't a number puts the saved value back. */
function NumberField({
  value,
  onSave,
  ariaLabel,
  className,
}: {
  value: number | null;
  onSave: (value: number | null) => Promise<boolean>;
  ariaLabel: string;
  className: string;
}) {
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  async function commit() {
    const next = draft.trim() === "" ? null : Number(draft);
    if (next !== null && !Number.isFinite(next)) return setDraft(shown);
    if (next === value) return;
    if (!(await onSave(next))) setDraft(shown);
  }

  return (
    <input
      type="number"
      step="any"
      aria-label={ariaLabel}
      value={draft}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(shown);
      }}
      className={className}
    />
  );
}

/** Markdown, edited rendered as in a note; saved shortly after typing stops, when focus leaves it, and on Ctrl+S. */
function DescriptionField({ task, onPatch }: { task: TaskItem; onPatch: (patch: TaskPatch) => Promise<boolean> }) {
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);
  // The editor parses its text once, so a description changed elsewhere remounts it.
  const [version, setVersion] = useState(0);
  // As in TextField: an auto-save coming back doesn't overwrite what was typed since.
  const sentRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (task.description !== sentRef.current && task.description !== draftRef.current) {
      setDraft(task.description);
      setVersion((v) => v + 1);
    }
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
      <div
        aria-label="Description"
        role="group"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) void commit();
        }}
      >
        <NoteEditor
          key={`${task.id}-${version}`}
          spaceId={task.space_id}
          value={draft}
          onChange={setDraft}
          onSave={() => void commit()}
          disabled={false}
          compact
        />
      </div>
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

// --- Dependencies -----------------------------------------------------------------

type DepsState = { state: "loading" } | { state: "ok"; deps: TaskDependencies } | { state: "error"; message: string };

/**
 * The tasks this one waits on ("Blocked by") and the tasks waiting on it ("Blocks"), collapsed by default. Each shows
 * its status and dates, a caution triangle when the dates contradict the dependency, and × to remove it.
 */
function Dependencies({ task }: { task: TaskItem }) {
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const [deps, setDeps] = useState<DepsState>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { openTask } = useTaskPanel();
  const statusColors = useSpace().spaces.find((s) => s.id === task.space_id)?.status_colors;
  const contentId = useId();

  // Loaded even while collapsed, so the header can show the count and any conflicts. Moving this task's dates
  // can make (or clear) a conflict, as can moving another task's on the board or the Gantt.
  useEffect(() => {
    const controller = new AbortController();
    fetchTaskDependencies(task.id, controller.signal)
      .then((body) => setDeps({ state: "ok", deps: body }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setDeps({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [task.id, task.start_date, task.deadline, reload]);
  useLinksChanged(() => setReload((n) => n + 1));
  useTaskChanges("panel", () => setReload((n) => n + 1));

  async function add(predecessorId: number, successorId: number) {
    setError(null);
    try {
      await createTaskLink(predecessorId, successorId);
      return true;
    } catch (err: unknown) {
      setError(`Could not add the dependency: ${message(err)}`);
      return false;
    }
  }

  async function remove(item: TaskLinkItem) {
    setError(null);
    try {
      await deleteTaskLink(item.link_id);
    } catch (err: unknown) {
      setError(`Could not remove the dependency: ${message(err)}`);
    }
  }

  const all = deps.state === "ok" ? [...deps.deps.blocked_by, ...deps.deps.blocks] : [];
  const conflicts = all.filter((d) => d.conflict).length;
  const exclude = new Set([task.id, ...all.map((d) => d.task_id)]);

  const group = (title: string, items: TaskLinkItem[], direction: "blocked_by" | "blocks") => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium uppercase tracking-wide text-text-muted">{title}</span>
      {items.length === 0 ? (
        <span className="text-xs text-text-muted">None</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.link_id} className="flex min-w-0 items-center gap-2 rounded-md border border-border-default bg-surface-raised px-2 py-1 text-[13px]">
              {item.conflict && (
                <span role="img" aria-label="Date conflict" title={item.conflict_reason ?? "The dates contradict this dependency"} className="shrink-0 text-amber-500">
                  ⚠
                </span>
              )}
              <button
                type="button"
                onClick={() => openTask(item.task_id)}
                className="min-w-0 flex-1 truncate text-left text-text-primary hover:text-accent hover:underline"
                title={`Open #${item.task_id} ${item.title}`}
              >
                {item.title}
              </button>
              <Tag className="shrink-0" style={pillStyle(statusColor(statusColors, item.status))}>
                {STATUS_LABELS[item.status]}
              </Tag>
              {(item.start_date || item.deadline) && (
                <span className="shrink-0 font-mono text-[11px] text-text-muted">{dateRange(item.start_date, item.deadline)}</span>
              )}
              <button
                type="button"
                onClick={() => void remove(item)}
                aria-label={`Remove dependency on ${item.title}`}
                title="Remove this dependency"
                className="shrink-0 text-text-muted hover:text-accent"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <TaskSearch
        spaceId={task.space_id}
        exclude={exclude}
        placeholder={direction === "blocked_by" ? "Add a task this one waits on…" : "Add a task waiting on this one…"}
        onPick={(other) => (direction === "blocked_by" ? add(other.id, task.id) : add(task.id, other.id))}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setDependenciesOpen((o) => !o)}
        aria-expanded={dependenciesOpen}
        aria-controls={contentId}
        className="flex items-center gap-1.5 self-start text-[13px] text-text-muted hover:text-text-primary"
      >
        <span aria-hidden className={`inline-block transition-transform ${dependenciesOpen ? "rotate-90" : ""}`}>
          ▸
        </span>
        Dependencies
        {all.length > 0 && <span className="rounded-full border border-border-default px-1.5 font-mono text-[11px] leading-4">{all.length}</span>}
        {conflicts > 0 && (
          <span className="text-amber-500" title={`${conflicts} date conflict${conflicts === 1 ? "" : "s"}`}>
            ⚠ {conflicts}
          </span>
        )}
      </button>
      {dependenciesOpen && (
        <div id={contentId} className="flex flex-col gap-3 pl-4">
          {deps.state === "loading" && <span className="text-xs text-text-muted">Loading…</span>}
          {deps.state === "error" && <span className="text-xs text-text-secondary">Could not load the dependencies ({deps.message}).</span>}
          {deps.state === "ok" && (
            <>
              {group("Blocked by", deps.deps.blocked_by, "blocked_by")}
              {group("Blocks", deps.deps.blocks, "blocks")}
            </>
          )}
          {error && <p className="text-xs text-accent">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** "1 Oct → 10 Oct" for a task's dates (either may be missing). */
function dateRange(start: string | null, end: string | null): string {
  const day = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  if (start && end) return `${day(start)} → ${day(end)}`;
  if (start) return `from ${day(start)}`;
  return end ? `due ${day(end)}` : "";
}

type TaskOption = Pick<TaskItem, "id" | "title" | "status">;

/** Type to find another task of the space (by title or #id); the space's tasks load the first time it's focused. */
function TaskSearch({
  spaceId,
  exclude,
  placeholder,
  onPick,
}: {
  spaceId: number;
  exclude: Set<number>;
  placeholder: string;
  onPick: (task: TaskOption) => Promise<boolean>;
}) {
  const [tasks, setTasks] = useState<TaskOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const listId = useId();

  function load() {
    if (tasks !== null) return;
    getJson<TaskItem[]>(`/api/tasks?space_id=${spaceId}`)
      .then((body) => setTasks(body.map(({ id, title, status }) => ({ id, title, status }))))
      .catch(() => setTasks([]));
  }

  const needle = query.trim().toLowerCase().replace(/^#/, "");
  const choices = (tasks ?? [])
    .filter((t) => !exclude.has(t.id) && (!needle || t.title.toLowerCase().includes(needle) || String(t.id) === needle))
    .slice(0, 50);

  async function pick(choice: TaskOption) {
    setOpen(false);
    if (await onPick(choice)) setQuery("");
  }

  return (
    <div ref={anchor} className="relative">
      <input
        role="combobox"
        aria-label={placeholder}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && choices[highlight] ? `${listId}-${choices[highlight].id}` : undefined}
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => {
          load();
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (choices.length === 0) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setHighlight((h) => (h + step + choices.length) % choices.length);
            setOpen(true);
          } else if (e.key === "Enter" && open && choices[highlight]) {
            e.preventDefault();
            void pick(choices[highlight]);
          } else if (e.key === "Escape" && (open || query)) {
            e.stopPropagation();
            setOpen(false);
            setQuery("");
          }
        }}
        className="field w-full py-1 text-xs"
      />
      <Popover anchor={anchor} open={open && tasks !== null} onClose={() => setOpen(false)} id={listId} label={placeholder}>
        {choices.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-text-muted">{needle ? "No matching tasks" : "No other tasks"}</div>
        ) : (
          choices.map((choice, index) => (
            <div
              key={choice.id}
              id={`${listId}-${choice.id}`}
              role="option"
              aria-selected={index === highlight}
              // Keep the focus in the input while picking.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => void pick(choice)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
                index === highlight ? "bg-surface-raised text-text-primary" : "text-text-secondary"
              }`}
            >
              <span className="font-mono text-[11px] text-text-muted">#{choice.id}</span>
              <span className="truncate">{choice.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-text-muted">{STATUS_LABELS[choice.status]}</span>
            </div>
          ))
        )}
      </Popover>
    </div>
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
          onPaste={(e) => pasteLink(e, setText)}
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
            onPaste={(e) => pasteLink(e, setDraft)}
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
        <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">
          <CommentText text={comment.text} />
        </p>
      )}
    </li>
  );
}

/** A comment's text with its links (pills, markdown links and bare URLs) shown as pills. */
function CommentText({ text }: { text: string }) {
  return (
    <>
      {linkSegments(text).map((segment, i) =>
        typeof segment === "string" ? segment : <StaticPill key={i} {...segment} />,
      )}
    </>
  );
}

/**
 * A link pasted into a comment goes in as a pill's markdown: over the selected text, labelled by it, or at the caret,
 * labelled by the link until the web page's title comes back to label it. Anything else pastes as usual.
 */
function pasteLink(event: ClipboardEvent<HTMLTextAreaElement>, setValue: (value: string) => void) {
  const href = pastedLink(event.clipboardData.getData("text/plain"));
  if (!href) return;
  event.preventDefault();
  const el = event.currentTarget;
  const { selectionStart: start, selectionEnd: end, value } = el;
  const pill = pillMarkdown(linkPill(href, value.slice(start, end)));
  setValue(value.slice(0, start) + pill + value.slice(end));
  // After React has put the new value in, the caret goes after the pill.
  requestAnimationFrame(() => el.setSelectionRange(start + pill.length, start + pill.length));
  if (start === end && isWebUrl(href)) {
    void fetchUrlTitle(href).then((title) => {
      // After the caret above has been placed, so the two don't race.
      requestAnimationFrame(() => {
        // Only while the pill is still there as pasted: not once it's been posted, edited or deleted.
        const at = el.value.indexOf(pill);
        if (!title || at < 0) return;
        const titled = pillMarkdown(linkPill(href, title));
        const { selectionStart: caret, selectionEnd: caretEnd } = el;
        // The caret stays where it was in the text around the pill.
        const shift = (pos: number) => (pos >= at + pill.length ? pos + titled.length - pill.length : Math.min(pos, at + titled.length));
        // Put in at once, so the caret can be put back before anything else is typed.
        flushSync(() => setValue(el.value.slice(0, at) + titled + el.value.slice(at + pill.length)));
        if (document.activeElement === el) el.setSelectionRange(shift(caret), shift(caretEnd));
      });
    });
  }
}

/** The backend stores naive UTC (see `utcnow`): read a time without a zone as UTC. */
function formatTime(iso: string): string {
  const utc = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  return new Date(utc).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
