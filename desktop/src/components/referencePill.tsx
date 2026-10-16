import { mergeAttributes, Node, type JSONContent } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

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
const PILL = /^\[((?:\\.|[^\\\]\n])*)\]\(<?([^\n"()]+?)>?(?:\s+"ref:(task|note|url)")?\s*\)/;

/** The kind of a link saved as a pill (by its title), or inferred from its href, or null for an ordinary link. */
export function refKind(title?: string | null, href?: string | null): RefKind | null {
  const match = title ? REF_TITLE.exec(title) : null;
  if (match) return match[1] as RefKind;
  if (!href) return null;
  if (taskIdFromHref(href) !== null || /taskId=\d+/.test(href) || /^\/tasks\/\d+/.test(href)) {
    return "task";
  }
  if (href.startsWith("/note?") || href.startsWith("/notes?") || /\.md($|[?#])/i.test(href)) {
    return "note";
  }
  if (isLocalHref(href)) {
    return "url";
  }
  return null;
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

/** A pill as saved in markdown: `[label](href "ref:kind")`. */
export function pillMarkdown({ kind, href, label }: RefPillAttrs): string {
  return `[${escapeLabel(label || href)}](${encodeHref(href)} "ref:${REF_KINDS.includes(kind) ? kind : "url"}")`;
}

/**
 * Pasted text that is a link on its own, to become a pill: a web or `file:` URL, a drive or UNC path, or a link to a
 * note or task in the app. Returns the link trimmed, or null.
 */
export function pastedLink(text: string): string | null {
  const link = text.trim();
  if (/^(?:https?|file):\/\/\S+$/i.test(link) || /^\/(?:notes?\?|tasks\/)\S*$/.test(link)) return link;
  // A path may hold spaces, but not run over lines.
  return /^(?:[a-z]:\\|\\\\[^\\\s]+\\)[^\r\n]*$/i.test(link) ? link : null;
}

/** The pill for a link: a task or note in the app shown as one, anything else as a URL; labelled by its href. */
export function linkPill(href: string, label?: string): RefPillAttrs {
  return { kind: refKind(null, href) ?? "url", href, label: label?.replace(/\s+/g, " ").trim() || href };
}

/** Web URLs in running text. Matches take the trailing punctuation of a sentence too: see `trimUrl`. */
export const BARE_URL = /https?:\/\/[^\s<>"'`]+/g;

/** A URL found in text without the punctuation that ends the sentence around it, or an unmatched `)`. */
export function trimUrl(url: string): string {
  let trimmed = url.replace(/[.,;:!?'"\]]+$/, "");
  while (trimmed.endsWith(")") && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0)) {
    trimmed = trimmed.slice(0, -1).replace(/[.,;:!?'"\]]+$/, "");
  }
  return trimmed;
}

/** Plain text with its bare web URLs written as pills, leaving those already in markdown links and code alone. */
export function pillBareUrlsInMarkdown(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~)/.test(line)) return line;
      // Only URLs starting a line or after a space: not one in `](…)`, `<…>`, quotes or backticks.
      return line.replace(/(^|\s)(https?:\/\/[^\s<>"'`]+)/g, (_match, before: string, url: string) => {
        const href = trimUrl(url);
        return `${before}${pillMarkdown(linkPill(href))}${url.slice(href.length)}`;
      });
    })
    .join("\n");
}

const LINKS_IN_TEXT = new RegExp(`${PILL.source.slice(1)}|(${BARE_URL.source})`, "g");

/** Plain text (a comment, say) split into its text and its links, pills or markdown links and bare web URLs alike. */
export function linkSegments(text: string): (string | RefPillAttrs)[] {
  const segments: (string | RefPillAttrs)[] = [];
  let last = 0;
  for (const match of text.matchAll(LINKS_IN_TEXT)) {
    const start = match.index ?? 0;
    let pill: RefPillAttrs;
    let end = start + match[0].length;
    if (match[4]) {
      const url = trimUrl(match[4]);
      pill = linkPill(url);
      end = start + url.length;
    } else {
      const href = decodeHref(match[2].trim());
      pill = { kind: (match[3] as RefKind | undefined) ?? refKind(null, href) ?? "url", href, label: unescapeLabel(match[1]) || href };
    }
    if (start > last) segments.push(text.slice(last, start));
    segments.push(pill);
    last = end;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

/** A pill outside the editor (in a comment, say): opens what it points to on click, as the editor's on double-click. */
export function StaticPill({ kind, href, label }: RefPillAttrs) {
  const { openTask } = useTaskPanel();
  const { spaceId } = useSpace();
  const taskId = kind === "task" ? taskIdFromHref(href) : null;
  const body = (
    <>
      <PillIcon kind={kind} href={href} />
      <span className="reference-pill-label">{label || href}</span>
    </>
  );
  if (kind === "url")
    return (
      <a
        href={href}
        title={href}
        target="_blank"
        rel="noopener noreferrer"
        className="reference-pill url"
        onClick={(e) => {
          // The browser won't open a local path from a web page: the backend does.
          if (!isLocalHref(href)) return;
          e.preventDefault();
          void openLocalFile(href);
        }}
      >
        {body}
      </a>
    );
  let target = href;
  if (kind === "note" && !href.startsWith("/note?")) {
    try {
      target = notePath(spaceId, decodeURIComponent(href));
    } catch {
      target = notePath(spaceId, href);
    }
  }
  return (
    <Link
      to={target}
      title={`${PILL_NAMES[kind]}: ${label}`}
      className={`reference-pill ${kind}`}
      onClick={(e) => {
        // Ctrl/Cmd-click still opens it in a new tab.
        if (taskId === null || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        openTask(taskId);
      }}
    >
      {body}
    </Link>
  );
}

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
      const rawTitle = match[3] ? `ref:${match[3]}` : null;
      const href = decodeHref(match[2].trim());
      const kind = refKind(rawTitle, href);
      if (!kind) return undefined;
      return { type: "referencePill", raw: match[0], label: unescapeLabel(match[1]), href, kind };
    },
  },
  parseMarkdown: (token, h) => h.createNode("referencePill", { kind: token.kind, href: token.href, label: token.label }),
  renderMarkdown: (node) => pillMarkdown((node.attrs ?? {}) as RefPillAttrs),

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
  const { spaceId } = useSpace();

  const taskId = kind === "task" ? taskIdFromHref(href) : null;
  const taskInfo = useTaskInfo(taskId);
  const status = taskInfo?.status ?? null;
  const assignee = taskInfo?.assignee ?? null;

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
    } else {
      let noteRelPath = href;
      try {
        noteRelPath = decodeURIComponent(href);
      } catch {
        // ignore
      }
      const target = kind === "note" && !href.startsWith("/note?") ? notePath(spaceId, noteRelPath) : href;
      navigate(target);
    }
  }

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      data-reference-pill=""
      data-kind={kind}
      data-href={href}
      title={`${kind === "url" ? href : `${PILL_NAMES[kind]}: ${label}`}${assignee ? ` · 👤 ${assignee}` : ""} (double-click to open)`}
      onDoubleClick={open}
      className={`reference-pill ${kind} ${selected ? "selected" : ""}`}
    >
      <PillIcon kind={kind} href={href} />
      <span className="reference-pill-label">
        {status && <StatusTag status={status} />}
        {label || href}
        {assignee && <AssigneeTag assignee={assignee} />}
      </span>
    </NodeViewWrapper>
  );
}

export type TaskPillInfo = {
  status: TaskStatus;
  assignee: string | null;
};

/**
 * The current status and assignee of the task a pill points to: fetched on mount and kept in step with `TASK_CHANGED`
 * from any view. Null until it's known, and for a task that's gone.
 */
export function useTaskInfo(taskId: number | null): TaskPillInfo | null {
  const [info, setInfo] = useState<TaskPillInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (taskId === null) return;
    const controller = new AbortController();
    getJson<TaskItem>(`/api/tasks/${taskId}`, controller.signal)
      .then((task) => setInfo(pillInfo(task)))
      .catch(() => {});
    const handle = (event: Event) => {
      const change = (event as CustomEvent<TaskChange>).detail;
      if (change.id !== taskId) return;
      if (change.deleted) setInfo(null);
      else if (change.task) setInfo(pillInfo(change.task));
    };
    window.addEventListener(TASK_CHANGED, handle);
    return () => {
      controller.abort();
      window.removeEventListener(TASK_CHANGED, handle);
    };
  }, [taskId]);
  return info;
}

const pillInfo = (task: TaskItem): TaskPillInfo => ({ status: task.status, assignee: task.assignee?.trim() || null });

/** The current status of the task a pill points to (see useTaskInfo). */
export function useTaskStatus(taskId: number | null): TaskStatus | null {
  return useTaskInfo(taskId)?.status ?? null;
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

/** The assignee as a subtle `· 👤 <name>` tag after a task pill's name. */
export function AssigneeTag({ assignee }: { assignee: string }) {
  return (
    <span title={`Assigned to ${assignee}`} className="ml-1.5 font-normal text-text-muted">
      · 👤 {assignee}
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
