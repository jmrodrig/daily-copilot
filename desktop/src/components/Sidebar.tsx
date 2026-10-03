import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { getJson } from "../lib/api";
import { projectSwatch } from "../lib/projects";
import type { GanttProject } from "./GanttChart";

// GET /api/notes (see NoteSummary in backend/schemas.py).
type NoteSummary = { path: string; title: string };

type TreeNode = {
  key: string;
  label: string;
  kind: "project" | "folder" | "note" | "plan";
  /** Route opened by clicking the label; folders and projects only toggle. */
  to?: string;
  children: TreeNode[];
};

const NAV_ITEMS = [
  { to: "/", label: "Today", end: true },
  { to: "/tasks", label: "All tasks", end: false },
  { to: "/emails", label: "Forwarded emails", end: false },
  { to: "/graph", label: "Notes graph", end: false },
  { to: "/people", label: "People", end: false },
];

const INBOX = "Inbox";
const LIBRARY = "Library";
// Project sub-folders in the order the mockups list them; anything else follows alphabetically.
const FOLDER_ORDER = ["Notes-in", "Tasks", "Design", "Meetings", "Forwarded emails"];
const EXPANDED_KEY = "copilot.treeExpanded";
const POLL_MS = 30_000;

export const notePath = (path: string) => `/note?path=${encodeURIComponent(path)}`;

function folderRank(name: string): number {
  const i = FOLDER_ORDER.findIndex((f) => f.toLowerCase() === name.toLowerCase());
  return i === -1 ? FOLDER_ORDER.length : i;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  const order = (n: TreeNode) => (n.kind === "plan" ? 0 : n.kind === "note" ? 2 : 1);
  return nodes
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        (a.kind === "folder" && b.kind === "folder" ? folderRank(a.label) - folderRank(b.label) : 0) ||
        a.label.localeCompare(b.label, undefined, { numeric: true }),
    )
    .map((n) => ({ ...n, children: sortNodes(n.children) }));
}

/** Folders from the note paths, one top-level node per project folder plus every Gantt project. */
function buildTree(notes: NoteSummary[], projects: GanttProject[]): { notes: TreeNode[]; library: TreeNode[] } {
  const root: TreeNode = { key: "", label: "", kind: "folder", children: [] };
  const folder = (parent: TreeNode, name: string): TreeNode => {
    const key = parent.key ? `${parent.key}/${name}` : name;
    let node = parent.children.find((c) => c.kind !== "note" && c.label === name);
    if (!node) {
      node = { key, label: name, kind: parent === root ? "project" : "folder", children: [] };
      parent.children.push(node);
    }
    return node;
  };

  for (const project of projects) folder(root, project.code);
  for (const note of notes) {
    const parts = note.path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) parent = folder(parent, part);
    parent.children.push({ key: note.path, label: note.title, kind: "note", to: notePath(note.path), children: [] });
  }
  for (const project of projects) {
    if (project.tasks.length === 0) continue;
    folder(root, project.code).children.push({
      key: `${project.code}/#plan`,
      label: "Plan (Gantt)",
      kind: "plan",
      to: `/plan/${encodeURIComponent(project.code)}`,
      children: [],
    });
  }

  const top = sortNodes(root.children);
  // Inbox last, top-level notes after the folders; the Library gets its own section.
  const rank = (n: TreeNode) => (n.kind === "note" ? 2 : n.label === INBOX ? 1 : 0);
  const library = top.find((n) => n.kind === "project" && n.label === LIBRARY);
  return {
    notes: top.filter((n) => n !== library).sort((a, b) => rank(a) - rank(b)),
    library: library?.children ?? [],
  };
}

/** The expanded tree rows from the last visit, or null on the first visit. */
function storedExpanded(): Set<string> | null {
  try {
    const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "null");
    return Array.isArray(value) ? new Set(value.filter((v) => typeof v === "string")) : null;
  } catch {
    return null;
  }
}

type Health = "loading" | "ok" | "error";

export default function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [projects, setProjects] = useState<GanttProject[]>([]);
  const [health, setHealth] = useState<Health>("loading");
  const [stored] = useState(storedExpanded);
  const [expanded, setExpanded] = useState<Set<string>>(() => stored ?? new Set());
  const location = useLocation();

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      getJson<{ status: string }>("/health", controller.signal)
        .then(() => setHealth("ok"))
        .catch(() => !controller.signal.aborted && setHealth("error"));
      getJson<NoteSummary[]>("/api/notes", controller.signal)
        .then(setNotes)
        .catch(() => {});
      getJson<{ projects: GanttProject[] }>("/api/gantt", controller.signal)
        .then((body) => setProjects(body.projects))
        .catch(() => {});
    };
    load();
    // Notes appear from captures and the Co-pilot, so refresh the tree now and then.
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [location.key]);

  const tree = useMemo(() => buildTree(notes, projects), [notes, projects]);

  // First visit: open the projects so the tree is not just a list of codes.
  useEffect(() => {
    if (stored === null && localStorage.getItem(EXPANDED_KEY) === null && tree.notes.length > 0) {
      const projects = tree.notes.filter((n) => n.kind === "project").map((n) => n.key);
      setExpanded((prev) => (projects.every((key) => prev.has(key)) ? prev : new Set([...prev, ...projects])));
    }
  }, [stored, tree]);

  // Reveal the open note (or plan) in the tree.
  useEffect(() => {
    const path =
      location.pathname === "/note"
        ? new URLSearchParams(location.search).get("path")
        : location.pathname.startsWith("/plan/")
          ? `${decodeURIComponent(location.pathname.slice("/plan/".length))}/#plan`
          : null;
    if (!path) return;
    const parts = path.split("/").slice(0, -1);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    setExpanded((prev) => (ancestors.every((key) => prev.has(key)) ? prev : new Set([...prev, ...ancestors])));
  }, [location.pathname, location.search]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  const current = location.pathname + location.search;

  return (
    <div className="flex h-full min-w-[264px] flex-col">
      <div className="flex items-center justify-between pb-2.5 pl-[18px] pr-3 pt-3.5">
        <span className="text-[17px] font-semibold">Co-Pilot</span>
        <IconButton label="Collapse page tree" onClick={onCollapse} direction="left" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-2.5">
        {NAV_ITEMS.map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => navClass(isActive)}>
            {label}
          </NavLink>
        ))}

        <SectionHeader>NOTES</SectionHeader>
        {tree.notes.length === 0 && <p className="px-2 py-1 text-xs text-text-muted">No notes yet.</p>}
        {tree.notes.map((node) => (
          <TreeRow key={node.key} node={node} depth={0} expanded={expanded} toggle={toggle} current={current} />
        ))}

        {tree.library.length > 0 && (
          <>
            <SectionHeader>LIBRARY</SectionHeader>
            {tree.library.map((node) => (
              <TreeRow key={node.key} node={node} depth={0} expanded={expanded} toggle={toggle} current={current} />
            ))}
          </>
        )}

        <div className="my-3 border-t border-border-default" />
        <NavLink to="/settings" className={({ isActive }) => navClass(isActive)}>
          Settings
        </NavLink>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-border-default px-[18px] py-3">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span
            className={`h-2 w-2 rounded-full ${
              health === "ok" ? "bg-project-p5002" : health === "error" ? "bg-red-400" : "bg-project-neutral"
            }`}
          />
          {health === "ok" ? "Backend online" : health === "error" ? "Backend offline" : "Connecting…"}
        </div>
        <div className="font-mono text-[11px] text-text-muted">{window.location.host}</div>
      </div>
    </div>
  );
}

function navClass(isActive: boolean): string {
  return `flex min-h-7 w-full items-center rounded-md px-2 text-left text-[13px] ${
    isActive ? "bg-surface-active font-medium text-text-primary" : "text-text-muted hover:bg-surface-hover"
  }`;
}

function SectionHeader({ children }: { children: string }) {
  return (
    <div className="mb-1 mt-3 border-t border-border-default px-2 pt-3 text-[11px] font-semibold tracking-[0.1em] text-text-muted">
      {children}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  toggle,
  current,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  current: string;
}) {
  const open = expanded.has(node.key);
  const hasChildren = node.children.length > 0;
  const active = node.to !== undefined && node.to === current;
  const style = active
    ? "bg-surface-active font-medium text-text-primary"
    : node.kind === "project"
      ? "font-semibold text-text-primary"
      : node.kind === "folder"
        ? `text-text-secondary ${depth === 0 ? "font-semibold" : "font-medium"}`
        : "text-text-muted";
  const label = (
    <>
      {node.kind === "project" && (
        <span className={`h-2 w-2 shrink-0 rounded-full ${projectSwatch(node.label).dot}`} aria-hidden="true" />
      )}
      <span className="truncate">{node.label}</span>
    </>
  );
  const labelClass = `flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 pr-2 text-left text-[13px] ${style}`;

  return (
    <>
      <div className="flex min-h-7 items-center rounded-md hover:bg-surface-hover" style={{ paddingLeft: 6 + depth * 14 }}>
        <button
          type="button"
          onClick={() => toggle(node.key)}
          aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
          aria-expanded={open}
          className={`flex h-6 w-5 shrink-0 items-center justify-center text-text-muted ${hasChildren ? "" : "invisible"}`}
        >
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
        </button>
        {node.to ? (
          <NavLink to={node.to} className={labelClass} title={node.label}>
            {label}
          </NavLink>
        ) : (
          <button type="button" onClick={() => toggle(node.key)} className={labelClass} title={node.label}>
            {label}
          </button>
        )}
      </div>
      {open &&
        node.children.map((child) => (
          <TreeRow key={child.key} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} current={current} />
        ))}
    </>
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
