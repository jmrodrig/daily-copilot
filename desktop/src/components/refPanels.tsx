import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { getJson, message, sendJson } from "../lib/api";
import { checkLocalFile, isLocalHref, type LocalFileCheck } from "../lib/localFiles";
import { STATUS_LABELS, type ProjectOption, type TaskCreate, type TaskItem } from "../lib/tasks";
import { noteHref, PillIcon, PILL_NAMES, taskHref, type RefPillAttrs } from "./referencePill";

/**
 * Where a panel's task or link goes, and where to show the panel (viewport px): the selected text (`from`..`to`,
 * replaced by the pill) or, from the `/` menu, the caret (`from` = `to`). `text` is the selected text, if any.
 */
export type PanelDraft = { text: string; from: number; to: number; top: number; left: number };

export const TASK_TITLE_MAX = 500; // `TaskCreate.title` in backend/schemas.py
const ASSIGNEE_MAX = 64; // `TaskCreate.assignee`
const PANEL_WIDTH = 340;

/** Where to open a panel under the text at `from`..`to` (viewport coordinates of both ends). */
export function panelPosition(start: { left: number; bottom: number }, end: { bottom: number }): { top: number; left: number } {
  return {
    top: Math.max(start.bottom, end.bottom) + 8,
    left: Math.min(Math.max(8, start.left), window.innerWidth - PANEL_WIDTH - 8),
  };
}

/**
 * A floating panel's frame: placed at the draft's position (moved up to stay on screen), closed by Escape
 * (`onClose(true)`, giving the editor its focus back) or a click outside it (`onClose(false)`).
 */
function usePanel(draft: PanelDraft, onClose: (refocus: boolean) => void) {
  const ref = useRef<HTMLFormElement>(null);
  const [top, setTop] = useState(draft.top);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Placed again whenever its height changes (the link panel grows as its results load).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => setTop(Math.max(8, Math.min(draft.top, window.innerHeight - el.offsetHeight - 8)));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft.top]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current(true);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  return { ref, style: { top, left: draft.left, width: PANEL_WIDTH, maxHeight: "calc(100vh - 16px)", overflowY: "auto" as const } };
}

const PANEL_CLASS = "fixed z-30 flex flex-col gap-2.5 rounded-lg border border-border-default bg-surface-raised p-3 shadow-xl";

/** How soon a new task is due: in a number of days, or on a date picked. */
type DueIn = "" | "1" | "2" | "7" | "custom";

const DUE_OPTIONS: { value: DueIn; label: string }[] = [
  { value: "", label: "No due date" },
  { value: "1", label: "1 day" },
  { value: "2", label: "2 days" },
  { value: "7", label: "1 week" },
  { value: "custom", label: "Custom date…" },
];

/** A local date `days` from today, as `YYYY-MM-DD`. */
function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The quick-create panel for a task, from selected text (its title pre-filled with it) or the `/` menu: title,
 * project (the note's own project by default), assignee, when it's due, whether it's already in progress (else it
 * goes to the backlog), and whether to link it to this note. Created, it's handed to `onCreated`, which puts its
 * pill in the note.
 */
export function TaskPanel({
  spaceId,
  notePath,
  draft,
  onCreated,
  onClose,
}: {
  spaceId: number;
  /** The note being edited; without it, the task can't be linked to it. */
  notePath?: string;
  draft: PanelDraft;
  onCreated: (task: TaskItem) => void;
  /** `refocus`: give the editor its focus back (not when the user clicked elsewhere). */
  onClose: (refocus: boolean) => void;
}) {
  const [title, setTitle] = useState(draft.text.slice(0, TASK_TITLE_MAX));
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [assignee, setAssignee] = useState("");
  const [dueIn, setDueIn] = useState<DueIn>("");
  const [customDate, setCustomDate] = useState(() => daysFromToday(3));
  const [inProgress, setInProgress] = useState(false);
  const [linked, setLinked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = usePanel(draft, onClose);

  useEffect(() => {
    const controller = new AbortController();
    getJson<ProjectOption[]>(`/api/projects?space_id=${spaceId}`, controller.signal)
      .then((list) => {
        setProjects(list);
        // A note in a project's folder suggests that project.
        const own = notePath && list.find((p) => p.folder_path && notePath.startsWith(`${p.folder_path}/`));
        if (own) setProjectId(own.id);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [spaceId, notePath]);

  const deadline = dueIn === "" ? null : dueIn === "custom" ? customDate || null : daysFromToday(Number(dueIn));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: TaskCreate = {
        space_id: spaceId,
        title: title.trim(),
        project_id: projectId,
        assignee: assignee.trim() || null,
        deadline,
        status: inProgress ? "in_progress" : "backlog",
        ...(linked && notePath && { note_path: notePath }),
      };
      onCreated(await sendJson<TaskItem>("POST", "/api/tasks", body));
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }

  return (
    <form ref={panel.ref} onSubmit={submit} aria-label="Create task" style={panel.style} className={PANEL_CLASS}>
      <PanelHeading kind="task">New task</PanelHeading>
      <Field label="Title">
        <input
          autoFocus
          onFocus={(e) => e.target.select()}
          value={title}
          maxLength={TASK_TITLE_MAX}
          placeholder="What needs doing?"
          onChange={(e) => setTitle(e.target.value)}
          className="field py-1 text-[15px]"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Project">
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
            className="field py-1 text-[15px]"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assignee">
          <input
            value={assignee}
            maxLength={ASSIGNEE_MAX}
            placeholder="Unassigned"
            onChange={(e) => setAssignee(e.target.value)}
            className="field py-1 text-[15px]"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Due in">
          <select value={dueIn} onChange={(e) => setDueIn(e.target.value as DueIn)} className="field py-1 text-[15px]">
            {DUE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {dueIn === "custom" ? (
          <Field label="Due date">
            <input
              type="date"
              value={customDate}
              min={daysFromToday(0)}
              onChange={(e) => setCustomDate(e.target.value)}
              className="field py-1 text-[15px]"
            />
          </Field>
        ) : (
          <span className="self-end pb-1.5 text-xs text-text-muted">{deadline ? `Due ${deadline}` : ""}</span>
        )}
      </div>
      <Toggle on={inProgress} onChange={setInProgress} hint={inProgress ? STATUS_LABELS.in_progress : `Off: goes to the ${STATUS_LABELS.backlog.toLowerCase()}`}>
        In progress
      </Toggle>
      {notePath && (
        <Toggle on={linked} onChange={setLinked}>
          Link task to this note
        </Toggle>
      )}
      {error && <p className="text-xs text-accent">Could not create the task ({error}).</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => onClose(true)} className="btn min-h-0 px-2 py-1 text-xs">
          Cancel
        </button>
        <button type="submit" className="btn-primary min-h-0 px-2 py-1 text-xs" disabled={!title.trim() || saving}>
          {saving ? "Creating…" : "Create task"}
        </button>
      </div>
    </form>
  );
}

// GET /api/notes/recent (see NoteRecent in backend/schemas.py).
type RecentNote = { path: string; title: string; tags: string[]; modified: string };

/** A task or note the link panel can point to. */
type Candidate = { kind: "task" | "note"; key: string; title: string; detail: string; tags: string[]; href: string };

type KindFilter = "all" | "note" | "task";
const RECENT_PER_KIND = 6;
const MAX_RESULTS = 20;

/** The text as a web address or local path, if it is one (`www.` gets `https://`), else null. */
function asUrl(text: string): string | null {
  const t = text.trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(t)) return t;
  if (/^www\.\S+\.\S+$/i.test(t)) return `https://${t}`;
  if (isLocalHref(t)) return t;
  return null;
}

/** A local path's check on the backend's file system: running, and its last answer (null until there is one). */
type LocalCheckState = { loading: boolean; result: LocalFileCheck | null };
const NO_LOCAL_CHECK: LocalCheckState = { loading: false, result: null };

/**
 * How well a candidate matches the search (lower is better), or null if it doesn't: every word must be in its
 * title or one of its tags, and a `#word` in a tag.
 */
function matchRank(c: Candidate, words: string[]): number | null {
  const title = c.title.toLowerCase();
  const tags = c.tags.map((t) => t.toLowerCase());
  let rank = 0;
  for (const word of words) {
    if (word.startsWith("#")) {
      const tag = word.slice(1);
      if (!tag) continue;
      if (!tags.some((t) => t.startsWith(tag))) return null;
    } else if (title.startsWith(word)) {
      // The best: the title starts with it.
    } else if (title.includes(word)) {
      rank += 1;
    } else if (tags.some((t) => t.includes(word))) {
      rank += 2;
    } else {
      return null;
    }
  }
  return rank;
}

/**
 * The link panel: search the space's tasks and notes by name or tag (`#tag`), most recently modified first until
 * something is typed, or paste a URL. A task or note is shown under its own title; a URL under the display text
 * typed (the selected text, by default). A local path is checked on the backend's file system as it's typed, and can
 * only be inserted once it's found. Picked, the link is handed to `onPick`, which puts its pill in the note.
 */
export function LinkPanel({
  spaceId,
  draft,
  onPick,
  onClose,
}: {
  spaceId: number;
  draft: PanelDraft;
  onPick: (pill: RefPillAttrs) => void;
  onClose: (refocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [notes, setNotes] = useState<RecentNote[] | null>(null);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [displayText, setDisplayText] = useState(draft.text);
  const [localCheck, setLocalCheck] = useState<LocalCheckState>(NO_LOCAL_CHECK);
  const panel = usePanel(draft, onClose);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getJson<RecentNote[]>(`/api/notes/recent?space_id=${spaceId}`, controller.signal),
      getJson<TaskItem[]>(`/api/tasks?space_id=${spaceId}`, controller.signal),
    ])
      .then(([n, t]) => {
        setNotes(n);
        // Tasks carry no modified time: the newest first.
        setTasks([...t].sort((a, b) => b.id - a.id));
      })
      .catch((err) => !controller.signal.aborted && setLoadError(message(err)));
    return () => controller.abort();
  }, [spaceId]);

  const url = asUrl(query);
  // The last title filled in for the user, so a newer page's title can replace it but never their own text.
  const fetchedTitle = useRef("");
  useEffect(() => {
    if (!url || !/^https?:/i.test(url)) return;
    const controller = new AbortController();
    // Wait for a pause in the typing; a pasted URL is fetched almost at once.
    const timer = setTimeout(() => {
      getJson<{ title: string | null }>(`/api/url-metadata?url=${encodeURIComponent(url)}`, controller.signal)
        .then(({ title }) => {
          if (!title) return;
          setDisplayText((text) => {
            if (text.trim() && text !== fetchedTitle.current) return text;
            fetchedTitle.current = title;
            return title;
          });
        })
        // No title: the pill falls back to the URL.
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  // A local path: does it exist on the backend's machine? Checked after a pause in the typing; its file or folder name
  // fills in the display text unless the user typed their own.
  const isLocal = isLocalHref(url);
  useEffect(() => {
    if (!url || !isLocalHref(url)) {
      setLocalCheck(NO_LOCAL_CHECK);
      return;
    }
    setLocalCheck({ loading: true, result: null });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkLocalFile(url, controller.signal)
        .then((result) => {
          setLocalCheck({ loading: false, result });
          const name = result.exists ? result.name : null;
          if (!name) return;
          setDisplayText((text) => {
            if (text.trim() && text !== url && text !== fetchedTitle.current) return text;
            fetchedTitle.current = name;
            return name;
          });
        })
        // Aborted: a newer path is being checked.
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);
  const localBlocked = isLocal && (localCheck.loading || !localCheck.result?.exists);

  const candidates = useMemo<Candidate[]>(
    () => [
      ...(notes ?? []).map((n) => ({
        kind: "note" as const,
        key: `note:${n.path}`,
        title: n.title,
        detail: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "",
        tags: n.tags,
        href: noteHref(spaceId, n.path),
      })),
      ...(tasks ?? []).map((t) => ({
        kind: "task" as const,
        key: `task:${t.id}`,
        title: t.title,
        detail: [t.project_code, STATUS_LABELS[t.status]].filter(Boolean).join(" · "),
        tags: t.tags,
        href: taskHref(t.id),
      })),
    ],
    [notes, tasks, spaceId],
  );

  const results = useMemo(() => {
    if (url) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const ofKind = candidates.filter((c) => kind === "all" || c.kind === kind);
    if (!words.length) {
      // Recently modified: a few of each kind (already newest first), or more of the one filtered to.
      if (kind !== "all") return ofKind.slice(0, MAX_RESULTS);
      return [...ofKind.filter((c) => c.kind === "note").slice(0, RECENT_PER_KIND), ...ofKind.filter((c) => c.kind === "task").slice(0, RECENT_PER_KIND)];
    }
    return ofKind
      .map((c, order) => ({ c, order, rank: matchRank(c, words) }))
      .filter((r): r is { c: Candidate; order: number; rank: number } => r.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .slice(0, MAX_RESULTS)
      .map((r) => r.c);
  }, [candidates, query, kind, url]);

  const index = Math.min(active, Math.max(results.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function pickCandidate(c: Candidate) {
    onPick({ kind: c.kind, href: c.href, label: c.title });
  }

  function insert() {
    if (selected) pickCandidate(selected);
    else if (url && !localBlocked) onPick({ kind: "url", href: url, label: displayText.trim() || url });
  }

  function onSearchKey(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!results.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + results.length) % results.length);
    } else if (event.key === "Enter" && !url && results[index]) {
      event.preventDefault();
      pickCandidate(results[index]);
    }
  }

  const loading = !loadError && (notes === null || tasks === null);
  // A task's or note's own title is always the pill's text.
  const shownText = selected ? selected.title : displayText;
  const groups = results.map((c, i) => ({ c, i, heading: i === 0 || results[i - 1].kind !== c.kind }));

  return (
    <form
      ref={panel.ref}
      onSubmit={(e) => {
        e.preventDefault();
        insert();
      }}
      aria-label="Insert link"
      style={panel.style}
      className={PANEL_CLASS}
    >
      <PanelHeading kind="url">Insert link</PanelHeading>
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
          setActive(0);
        }}
        onKeyDown={onSearchKey}
        placeholder="Search tasks and notes, #tag, or paste a URL"
        aria-label="Search or paste a URL"
        role="combobox"
        aria-expanded={!url}
        aria-controls="link-panel-results"
        className="field py-1 text-[15px]"
      />
      {!url && (
        <div role="tablist" aria-label="Show" className="flex gap-1">
          {(["all", "note", "task"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => {
                setKind(k);
                setActive(0);
              }}
              className={`rounded px-2 py-0.5 text-xs ${kind === k ? "bg-accent/[0.16] text-accent-soft" : "text-text-muted hover:bg-surface-hover hover:text-text-secondary"}`}
            >
              {k === "all" ? "All" : k === "note" ? "Notes" : "Tasks"}
            </button>
          ))}
        </div>
      )}
      {url ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 rounded-md border border-border-default px-2.5 py-2 text-[15px] text-text-secondary">
            <PillIcon kind="url" href={url} />
            <span className="truncate">{url}</span>
          </div>
          {isLocal && <LocalCheckStatus check={localCheck} />}
        </div>
      ) : (
        <ul id="link-panel-results" ref={listRef} role="listbox" aria-label="Tasks and notes" className="-mx-1 max-h-[min(15rem,40vh)] overflow-y-auto">
          {loading && <li className="px-2 py-2 text-xs text-text-muted">Loading…</li>}
          {loadError && <li className="px-2 py-2 text-xs text-accent">Could not load tasks and notes ({loadError}).</li>}
          {!loading && !loadError && results.length === 0 && <li className="px-2 py-2 text-xs text-text-muted">Nothing matches.</li>}
          {groups.map(({ c, i, heading }) => (
            <li key={c.key} role="presentation">
              {heading && (
                <p className="px-2 pb-1 pt-2 text-[13px] font-medium uppercase tracking-wider text-text-muted">
                  {query.trim() ? (c.kind === "note" ? "Notes" : "Tasks") : c.kind === "note" ? "Recent notes" : "Recent tasks"}
                </p>
              )}
              <button
                type="button"
                role="option"
                data-index={i}
                aria-selected={selected?.key === c.key}
                onMouseEnter={() => setActive(i)}
                onClick={() => setSelected(c)}
                onDoubleClick={() => pickCandidate(c)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                  selected?.key === c.key ? "bg-accent/[0.16]" : i === index ? "bg-surface-hover" : ""
                }`}
              >
                <span className="shrink-0 text-accent-soft">
                  <PillIcon kind={c.kind} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] text-text-primary">{c.title}</span>
                  {(c.detail || c.tags.length > 0) && (
                    <span className="truncate text-[13px] text-text-muted">
                      {[c.detail, ...c.tags.map((t) => `#${t}`)].filter(Boolean).join("  ")}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Field label="Display text">
        <input
          value={shownText}
          readOnly={!!selected}
          disabled={!selected && !url}
          onChange={(e) => setDisplayText(e.target.value)}
          placeholder={url ?? "Pick a task or note, or paste a URL"}
          className="field py-1 text-[15px] read-only:text-text-muted"
        />
      </Field>
      {selected && <p className="-mt-1.5 text-[13px] text-text-muted">A {PILL_NAMES[selected.kind].toLowerCase()} is shown under its own title.</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => onClose(true)} className="btn min-h-0 px-2 py-1 text-xs">
          Cancel
        </button>
        <button type="submit" className="btn-primary min-h-0 px-2 py-1 text-xs" disabled={!selected && (!url || localBlocked)}>
          Insert
        </button>
      </div>
    </form>
  );
}

/** Whether a local path in the link panel was found on the backend's file system, or why not. */
function LocalCheckStatus({ check }: { check: LocalCheckState }) {
  const { loading, result } = check;
  if (loading || !result) return <p className="text-[13px] text-text-muted" aria-live="polite">Checking server file system…</p>;
  if (result.exists)
    return (
      <p className="truncate text-[13px] text-emerald-500" aria-live="polite" title={result.path}>
        ✓ Exists on server ({result.type}: {result.name})
      </p>
    );
  return (
    <p className="text-[13px] text-red-400" role="alert">
      ⚠ Not found on server file system ({result.error || "File or folder does not exist"})
    </p>
  );
}

function PanelHeading({ kind, children }: { kind: "task" | "url"; children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-text-muted">
      <span className="text-accent-soft">
        <PillIcon kind={kind} size={12} />
      </span>
      {children}
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
      {label}
      {children}
    </label>
  );
}

/** An on/off switch with its label (and an optional hint after it). */
function Toggle({ on, onChange, hint, children }: { on: boolean; onChange: (on: boolean) => void; hint?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2 text-left text-xs text-text-secondary"
    >
      <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-surface-hover"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-text-primary transition-[left] ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      {children}
      {hint && <span className="text-text-muted">· {hint}</span>}
    </button>
  );
}
