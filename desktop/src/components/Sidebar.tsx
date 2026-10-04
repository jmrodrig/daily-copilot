import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import { getJson, message, sendJson } from "../lib/api";
import { notePath, useSpace } from "../lib/space";

// GET /api/tree (see TreeResponse and FolderNode in backend/schemas.py).
type NoteSummary = { path: string; title: string };
export type FolderNode = {
  name: string;
  path: string;
  is_project: boolean;
  is_reference: boolean;
  project_id: number | null;
  folders: FolderNode[];
  notes: NoteSummary[];
};
type Tree = { space_id: number; content: FolderNode; templates: NoteSummary[] };

const NAV_ITEMS = [
  { to: "/", label: "Today", end: true },
  { to: "/triage", label: "Triage", end: false },
  { to: "/emails", label: "Forwarded emails", end: false },
  { to: "/graph", label: "Notes graph", end: false },
  { to: "/people", label: "People", end: false },
];

const TASK_VIEWS = [
  { to: "/tasks/kanban", label: "Kanban" },
  { to: "/tasks/backlog", label: "Backlog" },
  { to: "/tasks/gantt", label: "Gantt" },
];

const EXPANDED_KEY = "copilot.treeExpanded";
const POLL_MS = 30_000;
const NEW_SPACE = "new";

/** The expanded folders (as `<space id>:<path>`) from the last visit. */
function storedExpanded(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "null");
    return Array.isArray(value) ? new Set(value.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

type Health = "loading" | "ok" | "error";
type Menu = { x: number; y: number; folder: FolderNode };
type Dialog = { kind: "note" | "folder"; parent: string };

export default function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { spaceId, treeVersion, refreshTree } = useSpace();
  const [tree, setTree] = useState<Tree | null>(null);
  const [health, setHealth] = useState<Health>("loading");
  const [expanded, setExpanded] = useState<Set<string>>(storedExpanded);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      getJson<{ status: string }>("/health", controller.signal)
        .then(() => setHealth("ok"))
        .catch(() => !controller.signal.aborted && setHealth("error"));
      getJson<Tree>(`/api/tree?space_id=${spaceId}`, controller.signal)
        .then(setTree)
        .catch(() => {});
    };
    load();
    // Notes appear from captures and the Co-pilot, so refresh the tree now and then.
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [spaceId, treeVersion, location.key]);

  // Reveal the open note in the tree.
  useEffect(() => {
    if (location.pathname !== "/note") return;
    const params = new URLSearchParams(location.search);
    if (Number(params.get("space") ?? spaceId) !== spaceId || params.get("root") === "templates") return;
    const parts = (params.get("path") ?? "").split("/").slice(0, -1);
    const keys = parts.map((_, i) => `${spaceId}:${parts.slice(0, i + 1).join("/")}`);
    setExpanded((prev) => (keys.every((key) => prev.has(key)) ? prev : new Set([...prev, ...keys])));
  }, [location.pathname, location.search, spaceId]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const key = `${spaceId}:${path}`;
      if (!next.delete(key)) next.add(key);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });

  async function setFlag(folder: FolderNode, flag: "is_project" | "is_reference") {
    setMenu(null);
    setMenuError(null);
    try {
      await sendJson("PUT", "/api/folders/meta", { space_id: spaceId, path: folder.path, [flag]: !folder[flag] });
      refreshTree();
    } catch (err: unknown) {
      setMenuError(`Could not update ${folder.name}: ${message(err)}`);
    }
  }

  const current = location.pathname + location.search;
  const content = tree?.space_id === spaceId ? tree.content : null;
  const isEmpty = content !== null && content.folders.length === 0 && content.notes.length === 0;

  return (
    <div className="flex h-full min-w-[264px] flex-col">
      <div className="flex items-center justify-between pb-2.5 pl-[18px] pr-3 pt-3.5">
        <span className="text-[17px] font-semibold">Co-Pilot</span>
        <IconButton label="Collapse page tree" onClick={onCollapse} direction="left" />
      </div>
      <SpaceSwitcher />

      <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-2.5">
        {NAV_ITEMS.map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => navClass(isActive)}>
            {label}
          </NavLink>
        ))}

        <SectionHeader>TASKS</SectionHeader>
        {TASK_VIEWS.map(({ to, label }) => (
          <NavLink key={to} to={to} className={({ isActive }) => navClass(isActive)}>
            {label}
          </NavLink>
        ))}

        <SectionHeader
          actions={
            <>
              <SmallButton label="New note" onClick={() => setDialog({ kind: "note", parent: "" })}>
                +
              </SmallButton>
              <SmallButton label="New folder" onClick={() => setDialog({ kind: "folder", parent: "" })}>
                <FolderIcon className="h-3 w-3" />
              </SmallButton>
            </>
          }
        >
          CONTENT
        </SectionHeader>
        {menuError && <p className="px-2 py-1 text-xs text-accent">{menuError}</p>}
        {isEmpty && <p className="px-2 py-1 text-xs text-text-muted">No notes yet.</p>}
        {content && (
          <FolderContents
            folder={content}
            depth={0}
            spaceId={spaceId}
            expanded={expanded}
            toggle={toggle}
            current={current}
            onMenu={(event, folder) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, folder });
            }}
          />
        )}

        <SectionHeader>TEMPLATES</SectionHeader>
        {tree?.space_id === spaceId && tree.templates.length === 0 && (
          <p className="px-2 py-1 text-xs text-text-muted">No templates in this space.</p>
        )}
        {tree?.space_id === spaceId &&
          tree.templates.map((template) => {
            const to = notePath(spaceId, template.path, "templates");
            return (
              <NavLink
                key={template.path}
                to={to}
                className={`${navClass(current === to)} gap-1.5`}
                title={`Template: ${template.path}`}
              >
                <TemplateIcon />
                <span className="truncate">{template.title}</span>
              </NavLink>
            );
          })}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-default px-[18px] py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span
              className={`h-2 w-2 rounded-full ${
                health === "ok" ? "bg-project-p5002" : health === "error" ? "bg-red-400" : "bg-project-neutral"
              }`}
            />
            {health === "ok" ? "Backend online" : health === "error" ? "Backend offline" : "Connecting…"}
          </div>
          <div className="truncate font-mono text-[11px] text-text-muted">{window.location.host}</div>
        </div>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `rounded-md px-2 py-1 text-xs ${isActive ? "bg-surface-active text-text-primary" : "text-text-muted hover:bg-surface-hover"}`
          }
        >
          Settings
        </NavLink>
      </div>

      {menu && (
        <FolderMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onFlag={(flag) => setFlag(menu.folder, flag)}
          onNew={(kind) => {
            setMenu(null);
            setDialog({ kind, parent: menu.folder.path });
          }}
        />
      )}
      {dialog && (
        <NewItemDialog
          dialog={dialog}
          spaceId={spaceId}
          templates={tree?.space_id === spaceId ? tree.templates : []}
          onClose={() => setDialog(null)}
          onCreated={(parent) => {
            if (parent) {
              // Open the folder the new item went into.
              setExpanded((prev) => new Set([...prev, `${spaceId}:${parent}`]));
            }
            refreshTree();
          }}
        />
      )}
    </div>
  );
}

function SpaceSwitcher() {
  const { spaces, spaceId, setSpaceId, createSpace } = useSpace();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  function choose(value: string) {
    if (value === NEW_SPACE) {
      setCreating(true);
      return;
    }
    setSpaceId(Number(value));
    // An open note belongs to the old space.
    if (location.pathname === "/note") navigate("/");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await createSpace(name.trim());
      setCreating(false);
      setName("");
      setError(null);
      if (location.pathname === "/note") navigate("/");
    } catch (err: unknown) {
      setError(message(err));
    }
  }

  return (
    <div className="px-2.5 pb-2">
      {creating ? (
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            placeholder="Space name, e.g. Private"
            maxLength={64}
            className="field py-1.5 text-[13px]"
          />
          {error && <p className="text-xs text-accent">{error}</p>}
          <div className="flex gap-1.5">
            <button type="submit" className="btn-primary min-h-8 flex-1 px-2 text-xs" disabled={!name.trim()}>
              Create space
            </button>
            <button type="button" className="btn min-h-8 px-2 text-xs" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <label className="block">
          <span className="sr-only">Space</span>
          <select
            value={spaces.some((s) => s.id === spaceId) ? String(spaceId) : ""}
            onChange={(e) => choose(e.target.value)}
            className="field cursor-pointer py-1.5 text-[13px] font-medium"
          >
            {spaces.length === 0 && <option value="">Loading spaces…</option>}
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
            <option value={NEW_SPACE}>+ New space…</option>
          </select>
        </label>
      )}
    </div>
  );
}

function navClass(isActive: boolean): string {
  return `flex min-h-7 w-full items-center rounded-md px-2 text-left text-[13px] ${
    isActive ? "bg-surface-active font-medium text-text-primary" : "text-text-muted hover:bg-surface-hover"
  }`;
}

function SectionHeader({ children, actions }: { children: string; actions?: ReactNode }) {
  return (
    <div className="mb-1 mt-3 flex items-center justify-between border-t border-border-default px-2 pt-3 text-[11px] font-semibold tracking-[0.1em] text-text-muted">
      <span>{children}</span>
      {actions && <span className="flex items-center gap-1">{actions}</span>}
    </div>
  );
}

function SmallButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded text-[13px] leading-none text-text-muted hover:bg-surface-hover hover:text-text-primary"
    >
      {children}
    </button>
  );
}

type TreeProps = {
  depth: number;
  spaceId: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  current: string;
  onMenu: (event: ReactMouseEvent, folder: FolderNode) => void;
};

/** A folder's sub-folders, then its notes, then (for a project) a link to its tasks. */
function FolderContents({ folder, ...props }: TreeProps & { folder: FolderNode }) {
  const { depth, spaceId, current } = props;
  return (
    <>
      {folder.project_id !== null && (
        <LeafLink
          depth={depth}
          to={`/tasks/kanban?project=${folder.project_id}`}
          active={current === `/tasks/kanban?project=${folder.project_id}`}
          label="Tasks"
          className="text-project-c7801"
        />
      )}
      {folder.folders.map((child) => (
        <FolderRow key={child.path} folder={child} {...props} />
      ))}
      {folder.notes.map((note) => {
        const to = notePath(spaceId, note.path);
        return <LeafLink key={note.path} depth={depth} to={to} active={current === to} label={note.title} />;
      })}
    </>
  );
}

function LeafLink({
  depth,
  to,
  active,
  label,
  className = "",
}: {
  depth: number;
  to: string;
  active: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div className="flex min-h-7 items-center rounded-md hover:bg-surface-hover" style={{ paddingLeft: 6 + depth * 14 }}>
      <span className="w-5 shrink-0" />
      <NavLink
        to={to}
        title={label}
        className={`flex min-h-7 min-w-0 flex-1 items-center rounded-md pl-1 pr-2 text-left text-[13px] ${
          active ? "bg-surface-active font-medium text-text-primary" : className || "text-text-muted"
        }`}
      >
        <span className="truncate">{label}</span>
      </NavLink>
    </div>
  );
}

function FolderRow({ folder, ...props }: TreeProps & { folder: FolderNode }) {
  const { depth, spaceId, expanded, toggle, onMenu } = props;
  const open = expanded.has(`${spaceId}:${folder.path}`);
  const hasChildren = folder.folders.length > 0 || folder.notes.length > 0 || folder.project_id !== null;
  const tags = [folder.is_project && "Project", folder.is_reference && "Reference data"].filter(Boolean).join(", ");

  return (
    <>
      <div
        className="flex min-h-7 items-center rounded-md hover:bg-surface-hover"
        style={{ paddingLeft: 6 + depth * 14 }}
        onContextMenu={(event) => onMenu(event, folder)}
      >
        <button
          type="button"
          onClick={() => toggle(folder.path)}
          aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`}
          aria-expanded={open}
          className={`flex h-6 w-5 shrink-0 items-center justify-center text-text-muted ${hasChildren ? "" : "invisible"}`}
        >
          <Chevron open={open} />
        </button>
        <button
          type="button"
          onClick={() => toggle(folder.path)}
          title={tags ? `${folder.path} (${tags}) · right-click for options` : `${folder.path} · right-click for options`}
          className={`flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 pr-2 text-left text-[13px] ${
            folder.is_project ? "font-semibold text-project-c7801" : `text-text-secondary ${depth === 0 ? "font-semibold" : "font-medium"}`
          }`}
        >
          <FolderIcon className={`h-3.5 w-3.5 shrink-0 ${folder.is_project ? "text-project-c7801" : "text-text-muted"}`} />
          <span className="truncate">{folder.name}</span>
          {folder.is_project && <Badge className="border-project-c7801/60 text-project-c7801">Project</Badge>}
          {folder.is_reference && <Badge className="border-project-r5301/60 text-project-r5301">Ref</Badge>}
        </button>
      </div>
      {open && <FolderContents folder={folder} {...props} depth={depth + 1} />}
    </>
  );
}

function Badge({ className, children }: { className: string; children: string }) {
  return (
    <span className={`shrink-0 rounded border px-1 font-mono text-[9px] font-normal uppercase leading-[14px] ${className}`}>
      {children}
    </span>
  );
}

function FolderMenu({
  menu,
  onClose,
  onFlag,
  onNew,
}: {
  menu: Menu;
  onClose: () => void;
  onFlag: (flag: "is_project" | "is_reference") => void;
  onNew: (kind: "note" | "folder") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    ref.current?.querySelector("button")?.focus();
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const { folder } = menu;
  const items: { label: string; onClick: () => void }[] = [
    { label: folder.is_project ? "Unmark as Project" : "Mark as Project", onClick: () => onFlag("is_project") },
    {
      label: folder.is_reference ? "Unmark as Reference Data" : "Mark as Reference Data",
      onClick: () => onFlag("is_reference"),
    },
    { label: "New note here…", onClick: () => onNew("note") },
    { label: "New folder here…", onClick: () => onNew("folder") },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${folder.name} options`}
      className="fixed z-50 min-w-[200px] rounded-lg border border-border-light bg-surface-raised py-1 shadow-xl"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 170) }}
    >
      <div className="truncate px-3 pb-1 pt-0.5 font-mono text-[11px] text-text-muted">{folder.path}</div>
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={item.onClick}
          className={`block w-full px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:outline-none ${
            i === 2 ? "border-t border-border-default" : ""
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function NewItemDialog({
  dialog,
  spaceId,
  templates,
  onClose,
  onCreated,
}: {
  dialog: Dialog;
  spaceId: number;
  templates: NoteSummary[];
  onClose: () => void;
  onCreated: (parent: string) => void;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const isNote = dialog.kind === "note";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = name.trim().replace(/[\\/]+/g, "-");
    if (!clean) return;
    const path = dialog.parent ? `${dialog.parent}/${clean}` : clean;
    setSaving(true);
    setError(null);
    try {
      if (isNote) {
        const note = await sendJson<{ path: string }>("POST", "/api/notes", {
          space_id: spaceId,
          path,
          title: name.trim(),
          template: template || null,
        });
        onCreated(dialog.parent);
        onClose();
        navigate(notePath(spaceId, note.path));
      } else {
        await sendJson("POST", "/api/folders", { space_id: spaceId, path });
        onCreated(dialog.parent);
        onClose();
      }
    } catch (err: unknown) {
      setError(message(err));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={onClose}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="panel flex w-[420px] flex-col gap-3"
        aria-label={isNote ? "New note" : "New folder"}
      >
        <h2 className="text-base font-semibold">{isNote ? "New note" : "New folder"}</h2>
        <p className="font-mono text-xs text-text-muted">in content/{dialog.parent && `${dialog.parent}/`}</p>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {isNote ? "Title" : "Folder name"}
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isNote ? "e.g. Design review 2026-10-04" : "e.g. Meetings"}
            className="field"
          />
        </label>
        {isNote && (
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Template
            <select value={template} onChange={(e) => setTemplate(e.target.value)} className="field">
              <option value="">Blank note</option>
              {templates.map((t) => (
                <option key={t.path} value={t.path}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="text-xs text-accent">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving || !name.trim()}>
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FolderIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.5h8.4A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M6 3h9l4 4v14H6z" strokeDasharray="3 2" />
    </svg>
  );
}

export function IconButton({
  label,
  onClick,
  direction,
}: {
  label: string;
  onClick: () => void;
  direction: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border-light bg-surface-raised text-text-secondary hover:text-text-primary"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}
