import { mergeAttributes, Node, type JSONContent } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getJson } from "../lib/api";
import { isLocalHref, openLocalFile } from "../lib/localFiles";
import { notePath, useSpace } from "../lib/space";
import {
  statusColor,
  STATUS_LABELS,
  taskIdFromHref,
  useTaskPanel,
  TASK_CHANGED,
  type TaskChange,
  type TaskItem,
  type TaskStatus,
} from "../lib/tasks";

/**
 * Inline reference pills, like Confluence's macros: a task, a note or a web page shown as an icon and its name.
 *
 * A pill is saved as a plain markdown link marked by its title, so the note reads the same in any other renderer
 * (a link with a tooltip) and the read-only view can show it as a pill again:
 *
 *   [Order the steel](/tasks/backlog?taskId=12 "ref:task")
 *   [Design review](/note?space=1&path=C7801%2Freview.md "ref:note")
 *   [Supplier site](https://example.com "ref:url")
 */
export type RefKind = "task" | "note" | "url";
export type RefPillAttrs = { kind: RefKind; href: string; label: string };

export const REF_KINDS: RefKind[] = ["task", "note", "url"];
const REF_TITLE = /^ref:(task|note|url)$/;
const PILL = /^\[((?:\\.|[^\\\]\n])*)\]\(([^\s()"<>]+) "ref:(task|note|url)"\)/;

/** The kind of a link saved as a pill (by its title), or null for an ordinary link. */
export function refKind(title: string | null | undefined): RefKind | null {
  const match = title ? REF_TITLE.exec(title) : null;
  return match ? (match[1] as RefKind) : null;
}

// Outside the app (or opened in a new tab) a task pill goes to the backlog with the task open in the side panel.
export const taskHref = (id: number) => `/tasks/backlog?taskId=${id}`;
export const noteHref = (spaceId: number, path: string) => notePath(spaceId, path);

/** The pill's content for `insertContent`, followed by a space so typing carries on after it. */
export function pillContent(attrs: RefPillAttrs): JSONContent[] {
  return [{ type: "referencePill", attrs }, { type: "text", text: " " }];
}

// The link text is markdown: escape what would be read as formatting or end it.
const escapeLabel = (label: string) => label.replace(/[\\[\]*_`<>]/g, "\\$&");
const unescapeLabel = (label: string) => label.replace(/\\(.)/g, "$1");
// The destination can't hold spaces, quotes, angle brackets or parentheses.
const encodeHref = (href: string) => href.replace(/[\s()"<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
// A local path (`C:\My Files`) is read back as it was: unlike a URL, nothing on the backend decodes it.
const decodeHref = (href: string) =>
  isLocalHref(href) && !/^file:/i.test(href) ? href.replace(/%(09|0A|0D|20|22|28|29|3C|3E)/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : href;

export const ReferencePill = Node.create({
  name: "referencePill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      kind: { default: "url", parseHTML: (el: HTMLElement) => el.getAttribute("data-kind") ?? "url" },
      href: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-href") ?? "" },
      label: { default: "", parseHTML: (el: HTMLElement) => el.textContent ?? "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-reference-pill]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { kind, href, label } = node.attrs as RefPillAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-reference-pill": "", "data-kind": kind, "data-href": href, class: `reference-pill ${kind}` }),
      label,
    ];
  },

  renderText: ({ node }) => (node.attrs as RefPillAttrs).label,

  markdownTokenName: "referencePill",
  markdownTokenizer: {
    name: "referencePill",
    level: "inline",
    start: (src: string) => src.indexOf("["),
    tokenize(src) {
      const match = PILL.exec(src);
      if (!match) return undefined;
      return { type: "referencePill", raw: match[0], label: unescapeLabel(match[1]), href: decodeHref(match[2]), kind: match[3] };
    },
  },
  parseMarkdown: (token, h) => h.createNode("referencePill", { kind: token.kind, href: token.href, label: token.label }),
  renderMarkdown: (node) => {
    const { kind, href, label } = (node.attrs ?? {}) as RefPillAttrs;
    return `[${escapeLabel(label || href)}](${encodeHref(href)} "ref:${REF_KINDS.includes(kind) ? kind : "url"}")`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(PillView, { as: "span" });
  },
});

/**
 * The pill in the editor: click selects it (to delete or move, or for a link, to open or edit it from NoteEditor's
 * menu), double-click opens what it points to. A local file or folder opens through the backend (see openLocalFile).
 */
function PillView({ node, selected, updateAttributes }: NodeViewProps) {
  const { kind, href, label } = node.attrs as RefPillAttrs;
  const navigate = useNavigate();
  const { openTask } = useTaskPanel();

  const taskId = kind === "task" ? taskIdFromHref(href) : null;
  const status = useTaskStatus(taskId);

  useEffect(() => {
    if (taskId === null) return;
    const handle = (event: Event) => {
      const change = (event as CustomEvent<TaskChange>).detail;
      if (change.id === taskId && change.task && change.task.title !== label) {
        updateAttributes({ label: change.task.title });
      }
    };
    window.addEventListener(TASK_CHANGED, handle);
    return () => window.removeEventListener(TASK_CHANGED, handle);
  }, [taskId, label, updateAttributes]);

  function open() {
    if (taskId !== null) openTask(taskId);
    else if (kind === "url") {
      if (isLocalHref(href)) void openLocalFile(href);
      else window.open(href, "_blank", "noopener,noreferrer");
    } else navigate(href);
  }

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      data-reference-pill=""
      data-kind={kind}
      data-href={href}
      title={`${kind === "url" ? href : `${PILL_NAMES[kind]}: ${label}`} (double-click to open)`}
      onDoubleClick={open}
      className={`reference-pill ${kind} ${selected ? "selected" : ""}`}
    >
      <PillIcon kind={kind} href={href} />
      <span className="reference-pill-label">
        {status && <StatusTag status={status} />}
        {label || href}
      </span>
    </NodeViewWrapper>
  );
}

/**
 * The current status of the task a pill points to: fetched on mount and kept in step with `TASK_CHANGED` from any
 * view. Null until it's known, and for a task that's gone.
 */
export function useTaskStatus(taskId: number | null): TaskStatus | null {
  const [status, setStatus] = useState<TaskStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (taskId === null) return;
    const controller = new AbortController();
    getJson<TaskItem>(`/api/tasks/${taskId}`, controller.signal)
      .then((task) => setStatus(task.status))
      .catch(() => {});
    const handle = (event: Event) => {
      const change = (event as CustomEvent<TaskChange>).detail;
      if (change.id !== taskId) return;
      if (change.deleted) setStatus(null);
      else if (change.task) setStatus(change.task.status);
    };
    window.addEventListener(TASK_CHANGED, handle);
    return () => {
      controller.abort();
      window.removeEventListener(TASK_CHANGED, handle);
    };
  }, [taskId]);
  return status;
}

/** The status as a bold `[IN_PROGRESS]` tag in its colour (the space's pick, else the default), in front of a task pill's name. */
export function StatusTag({ status }: { status: TaskStatus }) {
  const { space } = useSpace();
  return (
    <span
      title={STATUS_LABELS[status]}
      className="mr-1 font-bold tracking-wide"
      style={{ color: statusColor(space?.status_colors, status) }}
    >
      [{status.toUpperCase()}]
    </span>
  );
}

export const PILL_NAMES: Record<RefKind, string> = { task: "Task", note: "Note", url: "Link" };

/** A pill's icon: a checkbox for a task, a page for a note, a globe for a web page, a folder for a local file or folder. */
export function PillIcon({ kind, href, size = 13 }: { kind: RefKind; href?: string; size?: number }) {
  const local = kind === "url" && isLocalHref(href);
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="reference-pill-icon">
      {kind === "task" && (
        <>
          <rect x="1.7" y="1.7" width="12.6" height="12.6" rx="2.5" />
          <path d="M4.8 8.2l2.2 2.2 4.2-4.6" />
        </>
      )}
      {kind === "note" && (
        <>
          <path d="M9.5 1.7H4a1.3 1.3 0 0 0-1.3 1.3v10a1.3 1.3 0 0 0 1.3 1.3h8a1.3 1.3 0 0 0 1.3-1.3V5.5z" />
          <path d="M9.5 1.7v3.8h3.8M5.5 8.5h5M5.5 11h3.5" />
        </>
      )}
      {local && <path d="M1.7 4.2a1.2 1.2 0 0 1 1.2-1.2h3.2l1.6 1.8h5.4a1.2 1.2 0 0 1 1.2 1.2v6.6a1.2 1.2 0 0 1-1.2 1.2H2.9a1.2 1.2 0 0 1-1.2-1.2z" />}
      {kind === "url" && !local && (
        <>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M1.7 8h12.6M8 1.7c1.7 1.8 2.5 3.9 2.5 6.3S9.7 12.5 8 14.3C6.3 12.5 5.5 10.4 5.5 8S6.3 3.5 8 1.7z" />
        </>
      )}
    </svg>
  );
}
