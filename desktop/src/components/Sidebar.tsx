import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import { getJson, message, sendJson } from "../lib/api";
import { notePath, useSpace } from "../lib/space";
import { VIEW_TYPES, VIEWS_CHANGED, viewPath, type TaskView, type ViewType } from "../lib/views";

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
// POST /api/content/{move,rename,duplicate} (see ContentEntry in backend/schemas.py).
type ContentEntry = { kind: "note" | "folder"; path: string };
type TreeItem = { kind: "note"; note: NoteSummary } | { kind: "folder"; folder: FolderNode };

const itemPath = (item: TreeItem) => (item.kind === "note" ? item.note.path : item.folder.path);
const itemLabel = (item: TreeItem) => (item.kind === "note" ? item.note.title : item.folder.name);
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

/** Whether the note or folder at `source` can be dropped into `folder` ("" for content/ itself). */
function canDrop(source: string | null, folder: string): boolean {
  return source !== null && parentOf(source) !== folder && source !== folder && !folder.startsWith(`${source}/`);
}

const NAV_ITEMS = [
  { to: "/", label: "Today", end: true },
  { to: "/triage", label: "Triage", end: false },
  { to: "/emails", label: "Forwarded emails", end: false },
  { to: "/graph", label: "Notes graph", end: false },
  { to: "/people", label: "People", end: false },
];

const EXPANDED_KEY = "copilot.treeExpanded";
const POLL_MS = 30_000;
const NEW_SPACE = "new";
const DRAG_TYPE = "application/x-copilot-content";

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
type Menu = { x: number; y: number; item: TreeItem; add: boolean }; // add: a folder's "+" menu
type ViewMenu = { x: number; y: number; view: TaskView | null }; // null: the TASKS "+" menu
type Dialog = { kind: "note" | "folder"; parent: string; template?: string };

export default function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { spaceId, treeVersion, refreshTree } = useSpace();
  const [tree, setTree] = useState<Tree | null>(null);
  const [health, setHealth] = useState<Health>("loading");
  const [expanded, setExpanded] = useState<Set<string>>(storedExpanded);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [views, setViews] = useState<{ spaceId: number; views: TaskView[] } | null>(null);
  const [viewMenu, setViewMenu] = useState<ViewMenu | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [renamingItem, setRenamingItem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      getJson<TaskView[]>(`/api/views?space_id=${spaceId}`, controller.signal)
        .then((body) => setViews({ spaceId, views: body }))
        .catch(() => {});
    load();
    window.addEventListener(VIEWS_CHANGED, load);
    return () => {
      window.removeEventListener(VIEWS_CHANGED, load);
      controller.abort();
    };
  }, [spaceId]);

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

  /** The path of the content note open in this space, if any. */
  function openNote(): string | null {
    if (location.pathname !== "/note") return null;
    const params = new URLSearchParams(location.search);
    if (Number(params.get("space") ?? spaceId) !== spaceId || params.get("root") === "templates") return null;
    return params.get("path");
  }

  // Reveal the open note in the tree.
  useEffect(() => {
    const parts = (openNote() ?? "").split("/").slice(0, -1);
    const keys = parts.map((_, i) => `${spaceId}:${parts.slice(0, i + 1).join("/")}`);
    setExpanded((prev) => (keys.every((key) => prev.has(key)) ? prev : new Set([...prev, ...keys])));
  },[location.pathname, location.search, spaceId]);

  const updateExpanded = (change: (prev: Set<string>) => Set<string>) =>
    setExpanded((prev) => {
      const next = change(prev);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });

  const toggle = (path: string) =>
    updateExpanded((prev) => {
      const next = new Set(prev);
      const key = `${spaceId}:${path}`;
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /** Run a change to content/ from the tree, then reload the tree. */
  async function changeContent<T>(action: string, change: () => Promise<T>): Promise<T | undefined> {
    setMenu(null);
    setMenuError(null);
    try {
      const result = await change();
      refreshTree();
      return result;
    } catch (err: unknown) {
      setMenuError(`Could not ${action}: ${message(err)}`);
      return undefined;
    }
  }

  async function setFlag(folder: FolderNode, flag: "is_project" | "is_reference") {
    await changeContent(`update ${folder.name}`, () =>
      sendJson("PUT", "/api/folders/meta", { space_id: spaceId, path: folder.path, [flag]: !folder[flag] }),
    );
  }

  /** After a note or folder moved from `from` to `to`: keep its folders open, reveal it, and follow the open note. */
  function followMove(from: string, to: string) {
    const moved = (path: string) =>
      path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    const prefix = `${spaceId}:`;
    updateExpanded((prev) => {
      const next = new Set([...prev].map((key) => (key.startsWith(prefix) ? prefix + moved(key.slice(prefix.length)) : key)));
      if (parentOf(to)) next.add(prefix + parentOf(to));
      return next;
    });
    const open = openNote();
    if (open && moved(open) !== open) navigate(notePath(spaceId, moved(open)), { replace: true });
  }

  async function moveItem(path: string, destination: string) {
    const moved = await changeContent(`move ${path}`, () =>
      sendJson<ContentEntry>("POST", "/api/content/move", { space_id: spaceId, path, destination }),
    );
    if (moved) followMove(path, moved.path);
  }

  async function renameItem(item: TreeItem, name: string) {
    setRenamingItem(null);
    const clean = name.trim().replace(/[\\/]+/g, "-");
    if (!clean || clean === itemLabel(item)) return;
    const path = itemPath(item);
    const renamed = await changeContent(`rename ${itemLabel(item)}`, () =>
      sendJson<ContentEntry>("POST", "/api/content/rename", { space_id: spaceId, path, name: clean }),
    );
    if (renamed) followMove(path, renamed.path);
  }

  async function duplicateItem(item: TreeItem) {
    const copy = await changeContent(`duplicate ${itemLabel(item)}`, () =>
      sendJson<ContentEntry>("POST", "/api/content/duplicate", { space_id: spaceId, path: itemPath(item) }),
    );
    if (copy?.kind === "note") navigate(notePath(spaceId, copy.path));
  }

  async function deleteItem(item: TreeItem) {
    setMenu(null);
    const what = item.kind === "note" ? `the note "${item.note.title}"` : `the folder "${item.folder.name}" and everything in it`;
    if (!window.confirm(`Delete ${what}?`)) return;
    const path = itemPath(item);
    const deleted = await changeContent(`delete ${itemLabel(item)}`, () =>
      sendJson("DELETE", `/api/content?space_id=${spaceId}&path=${encodeURIComponent(path)}`).then(() => true),
    );
    const open = openNote();
    if (deleted && open && (open === path || open.startsWith(`${path}/`))) navigate("/");
  }

  const drag: DragActions = {
    start: setDragging,
    end: () => {
      setDragging(null);
      setDropTarget(null);
    },
    over: (event, folder) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      // The innermost row decides, so a folder's own rows never fall through to content/.
      event.stopPropagation();
      if (!canDrop(dragging, folder)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(folder);
    },
    leave: (folder) => setDropTarget((prev) => (prev === folder ? null : prev)),
    drop: (event, folder) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      const source = event.dataTransfer.getData(DRAG_TYPE);
      drag.end();
      if (canDrop(source, folder)) moveItem(source, folder);
    },
  };

  function openMenu(event: ReactMouseEvent<HTMLElement>, item: TreeItem, add: boolean) {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4, item, add });
  }

  function menuItems({ item, add }: Menu): MenuItem[] {
    const parent = itemPath(item);
    const create = (dialog: Dialog) => () => {
      setMenu(null);
      setDialog(dialog);
    };
    if (add) {
      return [
        { label: "New folder", onClick: create({ kind: "folder", parent }) },
        { label: "New note", onClick: create({ kind: "note", parent }) },
        ...(tree?.space_id === spaceId ? tree.templates : []).map((template, i) => ({
          label: `From template: ${template.title}`,
          separator: i === 0,
          onClick: create({ kind: "note", parent, template: template.path }),
        })),
      ];
    }
    const items: MenuItem[] = [
      {
        label: "Rename",
        onClick: () => {
          setMenu(null);
          setRenamingItem(itemPath(item));
        },
      },
      { label: "Duplicate", onClick: () => duplicateItem(item) },
      { label: "Delete", onClick: () => deleteItem(item) },
    ];
    if (item.kind === "folder") {
      const { folder } = item;
      items.push(
        {
          label: folder.is_project ? "Unmark as Project" : "Mark as Project",
          separator: true,
          onClick: () => setFlag(folder, "is_project"),
        },
        {
          label: folder.is_reference ? "Unmark as Reference Data" : "Mark as Reference Data",
          onClick: () => setFlag(folder, "is_reference"),
        },
      );
    }
    return items;
  }

  const spaceViews = views?.spaceId === spaceId ? views.views : null;

  /** Run a view change from the sidebar, then reload the sidebar and the open view. */
  async function changeViews<T>(action: string, change: () => Promise<T>): Promise<T | undefined> {
    setViewMenu(null);
    setViewError(null);
    try {
      const result = await change();
      window.dispatchEvent(new Event(VIEWS_CHANGED));
      return result;
    } catch (err: unknown) {
      setViewError(`Could not ${action}: ${message(err)}`);
      return undefined;
    }
  }

  async function createView(viewType: ViewType, name: string, filters?: TaskView["filters"]) {
    const created = await changeViews("create the view", () =>
      sendJson<TaskView>("POST", "/api/views", { space_id: spaceId, name: name.slice(0, 64), view_type: viewType, filters }),
    );
    if (created) navigate(viewPath(created.id));
    return created;
  }

  async function newView(viewType: ViewType) {
    const taken = new Set(spaceViews?.map((v) => v.name));
    let name: string = VIEW_TYPES[viewType];
    for (let n = 2; taken.has(name); n++) name = `${VIEW_TYPES[viewType]} ${n}`;
    const created = await createView(viewType, name);
    // Let the user name it straight away.
    if (created) setRenaming(created.id);
  }

  async function renameView(view: TaskView, name: string) {
    setRenaming(null);
    if (!name.trim() || name.trim() === view.name) return;
    await changeViews(`rename ${view.name}`, () => sendJson("PUT", `/api/views/${view.id}`, { name: name.trim() }));
  }

  async function deleteView(view: TaskView) {
    setViewMenu(null);
    if (!window.confirm(`Delete the view "${view.name}"? Its tasks are kept.`)) return;
    const deleted = await changeViews(`delete ${view.name}`, async () => {
      await sendJson("DELETE", `/api/views/${view.id}`);
      return true;
    });
    if (deleted && location.pathname === viewPath(view.id)) {
      const next = spaceViews?.find((v) => v.id !== view.id);
      navigate(next ? viewPath(next.id) : "/");
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

        <SectionHeader
          actions={
            <SmallButton
              label="New task view"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setViewMenu({ x: rect.left, y: rect.bottom + 4, view: null });
              }}
            >
              +
            </SmallButton>
          }
        >
          TASKS
        </SectionHeader>
        {viewError && <p className="px-2 py-1 text-xs text-accent">{viewError}</p>}
        {spaceViews?.length === 0 && <p className="px-2 py-1 text-xs text-text-muted">No task views. Add one with +.</p>}
        {spaceViews?.map((view) => (
          <TaskViewRow
            key={view.id}
            view={view}
            renaming={renaming === view.id}
            onRename={(name) => renameView(view, name)}
            onCancelRename={() => setRenaming(null)}
            onMenu={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setViewMenu({ x: rect.left, y: rect.bottom + 4, view });
            }}
          />
        ))}

        {/* Dropping on the header or between rows moves the item to the top of content/. */}
        <div
          onDragOver={(e) => drag.over(e, "")}
          onDragLeave={() => drag.leave("")}
          onDrop={(e) => drag.drop(e, "")}
          className={`rounded-md ${dropTarget === "" ? "bg-surface-hover/60 ring-1 ring-accent/70" : ""}`}
        >
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
              renaming={renamingItem}
              dragging={dragging}
              dropTarget={dropTarget}
              drag={drag}
              onMenu={openMenu}
              onContextMenu={(event, item) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, item, add: false });
              }}
              onRename={renameItem}
              onCancelRename={() => setRenamingItem(null)}
            />
          )}
        </div>

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
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={menu.add ? `New in ${itemLabel(menu.item)}` : `${itemLabel(menu.item)} options`}
          heading={itemPath(menu.item)}
          onClose={() => setMenu(null)}
          items={menuItems(menu)}
        />
      )}
      {viewMenu && (
        <PopupMenu
          x={viewMenu.x}
          y={viewMenu.y}
          label={viewMenu.view ? `${viewMenu.view.name} options` : "New task view"}
          onClose={() => setViewMenu(null)}
          items={
            viewMenu.view
              ? [
                  {
                    label: "Rename",
                    onClick: () => {
                      setViewMenu(null);
                      setRenaming(viewMenu.view!.id);
                    },
                  },
                  {
                    label: "Duplicate",
                    onClick: () => createView(viewMenu.view!.view_type, `${viewMenu.view!.name} copy`, viewMenu.view!.filters),
                  },
                  { label: "Delete", separator: true, onClick: () => deleteView(viewMenu.view!) },
                ]
              : (Object.keys(VIEW_TYPES) as ViewType[]).map((viewType) => ({
                  label: `New ${VIEW_TYPES[viewType]}`,
                  onClick: () => newView(viewType),
                }))
          }
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
    leaveOldSpace();
  }

  // An open note or saved view belongs to the old space.
  function leaveOldSpace() {
    if (location.pathname === "/note" || location.pathname.startsWith("/views/")) navigate("/");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await createSpace(name.trim());
      setCreating(false);
      setName("");
      setError(null);
      leaveOldSpace();
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

function SmallButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
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

type DragActions = {
  start: (path: string) => void;
  end: () => void;
  over: (event: DragEvent, folder: string) => void;
  leave: (folder: string) => void;
  drop: (event: DragEvent, folder: string) => void;
};

type TreeProps = {
  depth: number;
  spaceId: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  current: string;
  renaming: string | null;
  dragging: string | null;
  dropTarget: string | null;
  drag: DragActions;
  onMenu: (event: ReactMouseEvent<HTMLElement>, item: TreeItem, add: boolean) => void;
  onContextMenu: (event: ReactMouseEvent, item: TreeItem) => void;
  onRename: (item: TreeItem, name: string) => void;
  onCancelRename: () => void;
};

/** A folder's sub-folders, then its notes. */
function FolderContents({ folder, ...props }: TreeProps & { folder: FolderNode }) {
  const { spaceId, current } = props;
  return (
    <>
      {folder.folders.map((child) => (
        <FolderRow key={child.path} folder={child} {...props} />
      ))}
      {folder.notes.map((note) => {
        const to = notePath(spaceId, note.path);
        return (
          <TreeRow key={note.path} item={{ kind: "note", note }} {...props}>
            <span className="w-5 shrink-0" />
            <NavLink
              to={to}
              title={note.title}
              className={`flex min-h-7 min-w-0 flex-1 items-center rounded-md pl-1 pr-2 text-left text-[13px] ${
                current === to ? "bg-surface-active font-medium text-text-primary" : "text-text-muted"
              }`}
            >
              <span className="truncate">{note.title}</span>
            </NavLink>
          </TreeRow>
        );
      })}
    </>
  );
}

function FolderRow({ folder, ...props }: TreeProps & { folder: FolderNode }) {
  const { depth, spaceId, expanded, toggle } = props;
  const open = expanded.has(`${spaceId}:${folder.path}`);
  const hasChildren = folder.folders.length > 0 || folder.notes.length > 0;
  const tags = [folder.is_project && "Project", folder.is_reference && "Reference data"].filter(Boolean).join(", ");

  return (
    <>
      <TreeRow item={{ kind: "folder", folder }} {...props}>
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
          title={tags ? `${folder.path} (${tags})` : folder.path}
          className={`flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 pr-2 text-left text-[13px] ${
            folder.is_project ? "font-semibold text-project-c7801" : `text-text-secondary ${depth === 0 ? "font-semibold" : "font-medium"}`
          }`}
        >
          <FolderIcon className={`h-3.5 w-3.5 shrink-0 ${folder.is_project ? "text-project-c7801" : "text-text-muted"}`} />
          <span className="truncate">{folder.name}</span>
          {folder.is_project && <Badge className="border-project-c7801/60 text-project-c7801">Project</Badge>}
          {folder.is_reference && <Badge className="border-project-r5301/60 text-project-r5301">Ref</Badge>}
        </button>
      </TreeRow>
      {open && <FolderContents folder={folder} {...props} depth={depth + 1} />}
    </>
  );
}

/** A note or folder row: draggable, a drop target (a note's row stands for its folder), with
 *  "+" (folders) and "…" menus on hover, or an inline name field while renaming. */
function TreeRow({
  item,
  depth,
  renaming,
  dragging,
  dropTarget,
  drag,
  onMenu,
  onContextMenu,
  onRename,
  onCancelRename,
  children,
}: TreeProps & { item: TreeItem; children: ReactNode }) {
  const path = itemPath(item);
  const label = itemLabel(item);
  const folder = item.kind === "folder" ? path : parentOf(path);
  const indent = { paddingLeft: 6 + depth * 14 };

  if (renaming === path) {
    return (
      <div className="flex min-h-7 items-center pr-1" style={indent}>
        <span className="w-5 shrink-0" />
        <InlineRename defaultValue={label} label={`Rename ${label}`} onRename={(name) => onRename(item, name)} onCancel={onCancelRename} />
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, path);
        e.dataTransfer.effectAllowed = "move";
        drag.start(path);
      }}
      onDragEnd={drag.end}
      onDragOver={(e) => drag.over(e, folder)}
      onDragLeave={() => drag.leave(folder)}
      onDrop={(e) => drag.drop(e, folder)}
      onContextMenu={(e) => onContextMenu(e, item)}
      className={`group relative flex min-h-7 items-center rounded-md hover:bg-surface-hover ${
        item.kind === "folder" && dropTarget === path ? "bg-surface-hover ring-1 ring-accent/70" : ""
      } ${dragging === path ? "opacity-50" : ""}`}
      style={indent}
    >
      {children}
      <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-surface-hover opacity-0 focus-within:opacity-100 group-hover:opacity-100">
        {item.kind === "folder" && (
          <RowAction label={`New in ${label}`} title="New folder, note or note from a template" onClick={(e) => onMenu(e, item, true)}>
            +
          </RowAction>
        )}
        <RowAction label={`${label} options`} title="Rename, duplicate or delete" onClick={(e) => onMenu(e, item, false)}>
          …
        </RowAction>
      </span>
    </div>
  );
}

function RowAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className="flex h-5 w-5 items-center justify-center rounded text-[13px] leading-none text-text-muted hover:bg-surface-active hover:text-text-primary"
    >
      {children}
    </button>
  );
}

/** A name field that saves on Enter or blur and cancels on Escape. */
function InlineRename({
  defaultValue,
  label,
  maxLength,
  onRename,
  onCancel,
}: {
  defaultValue: string;
  label: string;
  maxLength?: number;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      defaultValue={defaultValue}
      maxLength={maxLength}
      aria-label={label}
      onFocus={(e) => {
        cancelled.current = false;
        e.target.select();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => !cancelled.current && onRename(e.target.value)}
      className="field min-w-0 flex-1 px-1.5 py-0.5 text-[13px]"
    />
  );
}

function Badge({ className, children }: { className: string; children: string }) {
  return (
    <span className={`shrink-0 rounded border px-1 font-mono text-[9px] font-normal uppercase leading-[14px] ${className}`}>
      {children}
    </span>
  );
}

type MenuItem = { label: string; onClick: () => void; separator?: boolean };

/** A small menu at (x, y), closed by clicking outside it or Escape. */
function PopupMenu({
  x,
  y,
  label,
  heading,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  heading?: string;
  items: MenuItem[];
  onClose: () => void;
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

  const height = items.length * 32 + (heading ? 30 : 10);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="fixed z-50 min-w-[200px] rounded-lg border border-border-light bg-surface-raised py-1 shadow-xl"
      style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - height) }}
    >
      {heading && <div className="truncate px-3 pb-1 pt-0.5 font-mono text-[11px] text-text-muted">{heading}</div>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={item.onClick}
          className={`block w-full px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:outline-none ${
            item.separator ? "border-t border-border-default" : ""
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A saved task view under TASKS: a link, a "…" menu on hover, or an inline name field while renaming. */
function TaskViewRow({
  view,
  renaming,
  onRename,
  onCancelRename,
  onMenu,
}: {
  view: TaskView;
  renaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  if (renaming) {
    return (
      <div className="flex min-h-7 items-center gap-1.5 px-2">
        <ViewIcon viewType={view.view_type} />
        <InlineRename
          defaultValue={view.name}
          maxLength={64}
          label={`Rename ${view.name}`}
          onRename={onRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    <div className="group relative">
      <NavLink
        to={viewPath(view.id)}
        title={`${view.name} · ${VIEW_TYPES[view.view_type]}`}
        className={({ isActive }) => `${navClass(isActive)} gap-1.5 pr-7`}
      >
        <ViewIcon viewType={view.view_type} />
        <span className="truncate">{view.name}</span>
      </NavLink>
      <button
        type="button"
        onClick={onMenu}
        aria-label={`${view.name} options`}
        title="Rename, duplicate or delete"
        className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[13px] leading-none text-text-muted opacity-0 hover:bg-surface-active hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
      >
        …
      </button>
    </div>
  );
}

function ViewIcon({ viewType }: { viewType: ViewType }) {
  const paths: Record<ViewType, string> = {
    kanban: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
    backlog: "M4 6h16M4 12h16M4 18h16",
    gantt: "M4 6h9M8 12h10M6 18h7",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d={paths[viewType]} />
    </svg>
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
  const [template, setTemplate] = useState(dialog.template ?? "");
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
