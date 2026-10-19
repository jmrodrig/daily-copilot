import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import { Link, useLocation, type Location } from "react-router-dom";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import { CHAT_PROMPT, errorDetail, getJson, message, PROMPTS_CHANGED, sendJson, uploadFile, type SavedPrompt } from "../lib/api";
import { isLocalHref, openLocalFile } from "../lib/localFiles";
import { notifyNoteUpdated } from "../lib/notes";
import { notePath, useSpace } from "../lib/space";
import MediaLightbox, { isPdfUrl } from "./MediaLightbox";
import { cleanMathForClipboard, copyCleanSelection } from "./noteFormatting";
import Popover from "./Popover";
import { AssistantButton } from "./Sidebar";

// Shapes of POST /api/chat(/stream) and POST /api/notes/apply-edit (see ChatResponse etc. in backend/schemas.py).
type AccessMode = "read_only" | "ask_first" | "write_directly";
type Frontmatter = Record<string, unknown>;
type ProposedEdit = {
  path: string;
  content: string;
  frontmatter: Frontmatter;
  previous_content: string | null;
  previous_frontmatter: Frontmatter | null;
  base_hash: string | null;
};
type ToolCall = { name: string; arguments: Record<string, unknown>; ok: boolean };
type ChatResponse = { reply: string; proposed_edits: ProposedEdit[]; written_paths: string[]; tool_calls: ToolCall[] };
// The NDJSON lines of POST /api/chat/stream (see stream_chat in backend/agent.py).
type StreamEvent =
  | { type: "thought"; subject: string | null; text: string }
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown> | null }
  | { type: "tool_end"; id: string; name: string; ok: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; detail: string; status_code: number };

/** What the agent is doing on the question in flight, as it streams in. */
type LiveToolCall = { id: string; name: string; arguments: Record<string, unknown>; status: "running" | "ok" | "error" };
type LivePhase = "thinking" | "answering" | "finished";
type LiveProgress = {
  thoughtSubject: string | null;
  thoughtText: string | null;
  tools: LiveToolCall[];
  streamingText: string;
  // A thought or tool call came after the last text, so the next text starts a new paragraph.
  textBroken: boolean;
  phase: LivePhase;
};
const NO_PROGRESS: LiveProgress = {
  thoughtSubject: null,
  thoughtText: null,
  tools: [],
  streamingText: "",
  textBroken: false,
  phase: "thinking",
};

type EditStatus =
  | { state: "pending" }
  | { state: "applying" }
  | { state: "applied" }
  | { state: "rejected" }
  | { state: "error"; message: string };
type Edit = ProposedEdit & { status: EditStatus };
/** A saved prompt used at the start of a message, e.g. "/prep Friday design review". */
type UsedPrompt = { command: string; instruction: string; rest: string };
/** A file attached to a question, stored in the space's assets (see ChatAttachment in backend/schemas.py). */
type ChatAttachment = { name: string; url: string; size?: number | null; content_type?: string | null };
type Entry =
  // `attachments` is missing from questions saved before files could be attached.
  | { role: "user"; content: string; prompt: UsedPrompt | null; context: string | null; attachments?: ChatAttachment[] }
  | { role: "assistant"; content: string; edits: Edit[]; written: string[]; toolCalls: ToolCall[] };
/** A conversation, kept in the space's chat history. */
type ChatThread = { id: string; title: string; createdAt: number; updatedAt: number; entries: Entry[] };
/** A space's conversations (most recent first) and the one open, null for a blank new chat. */
type ChatHistory = { spaceId: number; threads: ChatThread[]; activeId: string | null };

const MODES: { value: AccessMode; label: string }[] = [
  { value: "read_only", label: "Read only" },
  { value: "ask_first", label: "Ask first" },
  { value: "write_directly", label: "Write directly" },
];
const MODE_KEY = "copilot.accessMode";
// The model last picked in the chat (a bare name, e.g. "gemini-2.5-pro" or "claude-opus-4-6").
const MODEL_KEY = "copilot_chat_model";
type Effort = "auto" | "low" | "medium" | "high";
const EFFORTS: { value: Effort; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Default (model's native behavior)" },
  { value: "low", label: "Low", hint: "Fast, minimal thinking" },
  { value: "medium", label: "Medium", hint: "Balanced reasoning" },
  { value: "high", label: "High", hint: "Deep reasoning & thinking budget" },
];
// The reasoning effort last picked in the chat; "auto" leaves it to the model.
const EFFORT_KEY = "copilot_reasoning_effort";
const CONTEXT_LINES = 3;
const COMMAND_RE = /^(\/[a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
// Per space: its conversations (JSON ChatThread[]), and the id of the open one ("__new__" for a blank new chat).
const historyKey = (spaceId: number) => `copilot.chatHistory.${spaceId}`;
const activeChatKey = (spaceId: number) => `copilot.activeChat.${spaceId}`;
const NEW_CHAT = "__new__";
const MAX_THREADS = 50;
const TITLE_LENGTH = 60;
const NO_ENTRIES: Entry[] = [];

// The model picker's sections: Claude models run on the local `claude` CLI and Gemini ones on the local `gemini`
// CLI, both signed in with the user's account (no API key).
const isClaudeModel = (name: string) => name.startsWith("claude-");
const MODEL_GROUPS: { label: string; badge: string; matches: (name: string) => boolean }[] = [
  { label: "Claude Agent", badge: "Local CLI · No API", matches: isClaudeModel },
  { label: "Gemini Agent", badge: "Gemini API", matches: (name) => !isClaudeModel(name) },
];

/** A litellm model string without its provider (`gemini/gemini-2.5-pro` -> `gemini-2.5-pro`). */
function bareModel(model: string): string {
  return model.split("/").pop() ?? model;
}

function storedEffort(): Effort {
  const value = localStorage.getItem(EFFORT_KEY);
  return EFFORTS.some((e) => e.value === value) ? (value as Effort) : "auto";
}

function storedMode(): AccessMode {
  const value = localStorage.getItem(MODE_KEY);
  return MODES.some((m) => m.value === value) ? (value as AccessMode) : "ask_first";
}

/** Most recent first, keeping the latest `MAX_THREADS`. */
function sortThreads(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
}

type ChatHistoryResponse = {
  space_id: number;
  threads: ChatThread[];
  active_id: string | null;
};

/** Ensure an edit left "Saving…" when the page closed is reset to "Waiting for approval". */
function sanitizeThread(thread: ChatThread): ChatThread {
  return {
    ...thread,
    entries: (thread.entries || []).map((entry) =>
      entry.role === "assistant"
        ? {
            ...entry,
            edits: (entry.edits || []).map((e) =>
              e.status.state === "applying" ? { ...e, status: { state: "pending" } } : e,
            ),
          }
        : entry,
    ),
  };
}

/** Merge local and remote threads by id: keep newer updatedAt, keep local-only and remote-only, sort by updatedAt desc. */
function mergeThreads(local: ChatThread[], remote: ChatThread[]): ChatThread[] {
  const map = new Map<string, ChatThread>();
  for (const t of local) {
    map.set(t.id, t);
  }
  for (const r of remote) {
    const existing = map.get(r.id);
    if (!existing) {
      map.set(r.id, r);
    } else {
      if ((r.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(r.id, r);
      }
    }
  }
  return sortThreads(Array.from(map.values()));
}

/** The space's saved conversations; an edit left "Saving…" when the page closed is back to waiting for approval. */
function storedHistory(spaceId: number): ChatHistory {
  let threads: ChatThread[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(historyKey(spaceId)) ?? "[]");
    if (Array.isArray(saved)) threads = saved as ChatThread[];
  } catch {
    // Unreadable: start a fresh history.
  }
  threads = sortThreads(threads.map(sanitizeThread));
  // The conversation open last, else the most recent one.
  const active = localStorage.getItem(activeChatKey(spaceId));
  const open = active === NEW_CHAT ? undefined : (threads.find((t) => t.id === active) ?? threads[0]);
  return { spaceId, threads, activeId: open?.id ?? null };
}

function saveHistory({ spaceId, threads, activeId }: ChatHistory) {
  try {
    localStorage.setItem(historyKey(spaceId), JSON.stringify(threads));
    localStorage.setItem(activeChatKey(spaceId), activeId ?? NEW_CHAT);
  } catch {
    // Storage full: the conversation goes on, unsaved.
  }
}

/** A conversation's title: its first question on one line, cut at a word near `TITLE_LENGTH` characters. */
function threadTitle(entries: Entry[]): string {
  const first = entries.find((entry) => entry.role === "user");
  if (!first) return "New chat";
  const text =
    (first.prompt ? `${first.prompt.command} ${first.prompt.rest}` : first.content).replace(/\s+/g, " ").trim() ||
    first.attachments?.[0]?.name ||
    "New chat";
  if (text.length <= TITLE_LENGTH) return text;
  const cut = text.slice(0, TITLE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const newThreadId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** When a conversation was last active, e.g. "5m ago", "Yesterday" or "Mar 4". */
function relativeTime(time: number): string {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(Date.now()) - day(time)) / 86_400_000);
  if (days === 0) return `${Math.floor(minutes / 60)}h ago`;
  if (days === 1) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** What the chat shows as its context, the hint sent to the model with each question, and the open note. */
function pageContext(location: Location, spaceId: number): { label: string; hint: string | null; notePath: string | null } {
  const { pathname } = location;
  if (pathname === "/") return { label: "Today", hint: "the Today page (the day's schedule)", notePath: null };
  if (pathname === "/note") {
    const params = new URLSearchParams(location.search);
    const path = params.get("path") ?? "";
    const name = path.split("/").pop()?.replace(/\.md$/i, "") || "Note";
    if (params.get("root") === "templates") {
      return { label: `${name} template`, hint: path ? `the note template ${path} (not a note)` : null, notePath: null };
    }
    const inSpace = Number(params.get("space") ?? spaceId) === spaceId;
    return { label: name, hint: path ? `the note ${path}` : null, notePath: path && inSpace ? path : null };
  }
  if (pathname.startsWith("/tasks/")) {
    const view = pathname.slice("/tasks/".length);
    const label = `Tasks · ${view.charAt(0).toUpperCase()}${view.slice(1)}`;
    return { label, hint: `the ${view} view of the task database`, notePath: null };
  }
  if (pathname.startsWith("/views/")) {
    return { label: "Tasks · Saved view", hint: "a saved view of the task database", notePath: null };
  }
  if (pathname.startsWith("/plan/")) {
    const code = decodeURIComponent(pathname.slice("/plan/".length));
    return { label: `${code} plan`, hint: `the ${code} Gantt plan`, notePath: null };
  }
  const labels: Record<string, string> = {
    "/triage": "Triage",
    "/check-in": "Evening check-in",
    "/emails": "Forwarded emails",
    "/graph": "Notes graph",
    "/people": "People",
  };
  return { label: labels[pathname] ?? "Wiki", hint: null, notePath: null };
}

/** The page's context plus the task open in the task panel (`?taskId=`), if any. */
function withTask(context: ReturnType<typeof pageContext>, location: Location): ReturnType<typeof pageContext> {
  const taskId = Number(new URLSearchParams(location.search).get("taskId")) || null;
  if (taskId === null) return context;
  const task = `task #${taskId} (open in the task panel)`;
  return { ...context, label: `${context.label} · Task #${taskId}`, hint: context.hint ? `${context.hint}, with ${task}` : task };
}

/** What the model sees of a turn: saved prompts expanded, plus what the user did with proposed edits. */
function historyContent(entry: Entry): string {
  if (entry.role === "user") {
    const parts = [];
    if (entry.context) parts.push(`[The user is looking at ${entry.context}]`);
    if (entry.prompt) {
      parts.push(`[Saved prompt ${entry.prompt.command}]\n${entry.prompt.instruction}`);
      if (entry.prompt.rest) parts.push(`User input: ${entry.prompt.rest}`);
    } else {
      parts.push(entry.content);
    }
    return parts.join("\n\n");
  }
  const outcomes = entry.edits
    .filter((e) => e.status.state === "applied" || e.status.state === "rejected")
    .map((e) => `[The user ${e.status.state === "applied" ? "approved and saved" : "rejected"} the edit to ${e.path}]`);
  return [entry.content, ...outcomes].join("\n\n");
}

type ProgressEvent = Exclude<StreamEvent, { type: "done" } | { type: "error" }>;

/** The response of a POST /api/chat/stream, passing each progress event on as it arrives. */
async function readResponse(res: Response, onProgress: (event: ProgressEvent) => void): Promise<ChatResponse> {
  if (!res.body) throw new Error("the server sent no answer");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? ""); // an incomplete last line waits for the rest
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as StreamEvent;
      if (event.type === "error") throw new Error(event.detail || "Chat failed");
      if (event.type === "done") return event.response;
      onProgress(event);
    }
    if (done) throw new Error("the answer stopped before it was complete");
  }
}

function progressWith(progress: LiveProgress, event: ProgressEvent): LiveProgress {
  switch (event.type) {
    case "thought":
      return { ...progress, thoughtSubject: event.subject, thoughtText: event.text || null, textBroken: true, phase: "thinking" };
    case "tool_start": {
      const tool: LiveToolCall = { id: event.id, name: event.name, arguments: event.arguments ?? {}, status: "running" };
      return { ...progress, tools: [...progress.tools, tool], textBroken: true, phase: "thinking" };
    }
    case "tool_end": {
      // The latest running call with this id (ids may repeat across a turn's rounds).
      let index = -1;
      progress.tools.forEach((t, i) => {
        if (t.id === event.id && t.status === "running") index = i;
      });
      const status = event.ok ? "ok" : "error";
      return { ...progress, tools: progress.tools.map((t, i) => (i === index ? { ...t, status } : t)), phase: "thinking" };
    }
    case "text_delta": {
      const text = progress.streamingText;
      // Text after a thought or tool call is a new block of the reply, not more of the same sentence: a blank line
      // between them, so a heading, list or table that starts it parses as one.
      if (progress.textBroken && text && !event.delta.startsWith("\n\n"))
        return { ...progress, streamingText: `${text.trimEnd()}\n\n${event.delta.replace(/^\n/, "")}`, textBroken: false, phase: "answering" };
      return { ...progress, streamingText: text + event.delta, textBroken: false, phase: "answering" };
    }
  }
}

/**
 * Progressively pays out text chunk by chunk to simulate a smooth typewriter/writing delivery
 * when the server returns a bulk reply without live token streaming deltas.
 */
function payoutReply(
  fullText: string,
  onTick: (text: string) => void,
  signal: AbortSignal,
  onRegisterCancel: (fn: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const tokens = fullText.match(/\S+\s*|\n+/g) || [fullText];
    const totalTokens = tokens.length;
    // Step size ensures responses under 60 words type out word by word, and longer responses
    // finish within ~1.5-2 seconds without feeling sluggish.
    const step = Math.max(1, Math.min(6, Math.ceil(totalTokens / 60)));
    const delayMs = 20;

    let index = 0;
    let current = "";
    let timer: number | null = null;
    let finished = false;

    const finishInstantly = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) window.clearTimeout(timer);
      onTick(fullText);
      resolve();
    };

    onRegisterCancel(finishInstantly);

    if (signal.aborted) {
      finishInstantly();
      return;
    }

    const nextTick = () => {
      if (finished || signal.aborted) {
        finishInstantly();
        return;
      }
      if (index >= tokens.length) {
        finishInstantly();
        return;
      }
      const chunk = tokens.slice(index, index + step).join("");
      current += chunk;
      index += step;
      onTick(current);
      if (index < tokens.length) {
        timer = window.setTimeout(nextTick, delayMs);
      } else {
        finishInstantly();
      }
    };

    nextTick();
  });
}

/**
 * A reply's markdown, with GFM tables, math (KaTeX) and links to local files that open through the backend. Its
 * wrapper copies with `copyCleanSelection`, so math pastes as math rather than its text twice over.
 */
function ChatMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={chatUrlTransform}
      components={CHAT_MARKDOWN_COMPONENTS}
    >
      {content}
    </Markdown>
  );
}

/** Keeps links to local files and folders, which react-markdown would strip (as noteUrlTransform in NotePage). */
function chatUrlTransform(url: string): string {
  if (/^file:/i.test(url)) return url;
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // A stray `%`: leave it be.
  }
  return isLocalHref(decoded) ? decoded : defaultUrlTransform(url);
}

const CHAT_MARKDOWN_COMPONENTS: Components = {
  // A link to a page of the app (a note, a task view) opens in place. The browser won't open a local path from a web
  // page, so a link to one opens through the backend.
  a: ({ node: _node, ref: _ref, ...props }) => {
    const href = props.href;
    if (href && /^\/(?!\/|api\/)/.test(href)) {
      const { href: _href, ...rest } = props;
      return <Link {...rest} to={href} />;
    }
    if (!isLocalHref(href)) return <a {...props} target="_blank" rel="noopener noreferrer" />;
    return (
      <a
        {...props}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          void openLocalFile(href);
        }}
      />
    );
  },
  // Agents cite files as inline code (`\server\share\…`, `Y:\…`): such a span opens the file too.
  code: ({ node: _node, ref: _ref, ...props }) => {
    const text = typeof props.children === "string" ? props.children.trim() : "";
    if (/language-/.test(props.className ?? "") || text.includes("\n") || !isLocalHref(text)) return <code {...props} />;
    return (
      <code
        {...props}
        role="link"
        tabIndex={0}
        title={`Open ${text}`}
        className="cursor-pointer hover:border-accent hover:text-accent"
        onClick={() => void openLocalFile(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void openLocalFile(text);
        }}
      />
    );
  },
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The last two segments of a folder path, e.g. "Projects/C7801". */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/") || path;
}

function shortUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.length > 24 ? `${pathname.slice(0, 24)}…` : pathname;
    return hostname + (path === "/" ? "" : path);
  } catch {
    return url;
  }
}

/** What a tool call does, in words: our own tools, and the Claude and Gemini CLIs' ones. */
function describeToolCall(name: string, args: Record<string, unknown>): { action: string; target: string } {
  const text = (...values: unknown[]) => String(values.find((v) => v !== undefined && v !== null && v !== "") ?? "");
  switch (name) {
    case "search_local_files":
    case "Glob":
    case "glob":
      return { action: "Searching files", target: text(args.query, args.pattern, args.path) };
    case "Grep":
    case "grep_search":
      return { action: "Searching contents", target: text(args.query, args.pattern) };
    case "list_local_directory":
    case "list_directory":
      return { action: "Listing folder", target: shortPath(text(args.path, args.dir_path)) };
    case "read_local_file":
    case "Read":
    case "read_file":
      return { action: "Reading file", target: basename(text(args.file_path, args.absolute_path, args.path)) };
    case "search_notes":
      return { action: "Searching notes", target: text(args.query) || "recent notes" };
    case "read_note":
      return { action: "Reading note", target: text(args.path) };
    case "write_note":
      return { action: "Writing note", target: text(args.path) };
    case "list_tasks":
      return { action: "Checking tasks", target: text(args.project) || "all projects" };
    case "search_web":
    case "WebSearch":
    case "google_web_search":
      return { action: "Searching the web", target: text(args.query) };
    case "fetch_web_page":
    case "WebFetch":
    case "web_fetch":
      return { action: "Reading web page", target: shortUrl(text(args.url)) };
    default:
      return { action: name, target: Object.values(args).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ") };
  }
}

/** A tool call as the chat lists it, e.g. `search_notes("hull")`. */
function rawToolCall(name: string, args: Record<string, unknown>): string {
  return `${name}(${Object.values(args).map((v) => JSON.stringify(v)).join(", ")})`;
}

/**
 * The chat, in the right-most column (see Layout); `active` is false while it is collapsed. While `pinned`, opening a
 * task leaves the chat expanded.
 */
export default function CopilotChat({
  active,
  onCollapse,
  pinned,
  onPinnedChange,
}: {
  active: boolean;
  onCollapse: () => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
}) {
  const location = useLocation();
  const { spaceId, space } = useSpace();
  // The open conversation lives in the space's history, saved as it changes; it stays put across pages.
  const [history, setHistory] = useState<ChatHistory>(() => storedHistory(spaceId));
  const [historyMenu, setHistoryMenu] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const activeThread = history.threads.find((t) => t.id === history.activeId) ?? null;
  const entries = activeThread?.entries ?? NO_ENTRIES;
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AccessMode>(storedMode);
  const [sending, setSending] = useState(false);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The model picked (else the server's default, once known), and the ones on offer (GET /api/models).
  const [model, setModel] = useState<string | null>(() => localStorage.getItem(MODEL_KEY));
  const [models, setModels] = useState<string[]>([]);
  const [modelMenu, setModelMenu] = useState(false);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [effort, setEffort] = useState<Effort>(storedEffort);
  const [effortMenu, setEffortMenu] = useState(false);
  const effortButtonRef = useRef<HTMLButtonElement>(null);
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The entry whose reply was just copied, shown as "Copied" for a moment.
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  // Aborts the question in flight (Stop, a space change, or unmounting).
  const abortControllerRef = useRef<AbortController | null>(null);
  const stopPayoutRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Files attached to the question being written, the ones still uploading, and why one couldn't be.
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState<{ id: string; name: string }[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The attachment opened in the lightbox.
  const [openedAttachment, setOpenedAttachment] = useState<ChatAttachment | null>(null);
  const context =withTask(pageContext(location, spaceId), location);

  // Remote sync: merge local history with backend, debounce PUT on local changes, refetch on focus.
  const lastRemoteSnapshotRef = useRef<string>("");
  const syncTimeoutRef = useRef<number | null>(null);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  const pushRemoteHistory = useCallback(async (currentHistory: ChatHistory) => {
    try {
      const payload = {
        space_id: currentHistory.spaceId,
        threads: currentHistory.threads,
        active_id: currentHistory.activeId,
      };
      const snapshot = JSON.stringify(payload);
      if (snapshot === lastRemoteSnapshotRef.current) return;

      const res = await sendJson<ChatHistoryResponse>("PUT", "/api/chat/history", payload);
      lastRemoteSnapshotRef.current = JSON.stringify({
        space_id: res.space_id,
        threads: sortThreads((res.threads || []).map(sanitizeThread)),
        active_id: res.active_id ?? null,
      });
    } catch {
      // Sync failed: will retry on next edit or window focus
    }
  }, []);

  const pullRemoteHistory = useCallback(
    async (targetSpaceId: number) => {
      try {
        const data = await getJson<ChatHistoryResponse>(`/api/chat/history?space_id=${targetSpaceId}`);
        if (data.space_id !== targetSpaceId) return;

        const remoteThreads = sortThreads((data.threads || []).map(sanitizeThread));
        const remoteActiveId = data.active_id ?? null;

        setHistory((prev) => {
          if (prev.spaceId !== targetSpaceId) return prev;

          const merged = mergeThreads(prev.threads, remoteThreads);
          const activeId =
            prev.activeId && merged.some((t) => t.id === prev.activeId)
              ? prev.activeId
              : remoteActiveId && merged.some((t) => t.id === remoteActiveId)
                ? remoteActiveId
                : null;

          const nextHistory: ChatHistory = {
            spaceId: targetSpaceId,
            threads: merged,
            activeId,
          };

          const remoteSnapshot = JSON.stringify({
            space_id: targetSpaceId,
            threads: remoteThreads,
            active_id: remoteActiveId,
          });

          const mergedSnapshot = JSON.stringify({
            space_id: targetSpaceId,
            threads: merged,
            active_id: activeId,
          });

          lastRemoteSnapshotRef.current = remoteSnapshot;

          if (mergedSnapshot !== remoteSnapshot) {
            if (syncTimeoutRef.current !== null) window.clearTimeout(syncTimeoutRef.current);
            syncTimeoutRef.current = window.setTimeout(() => {
              void pushRemoteHistory(nextHistory);
            }, 1000);
          }

          saveHistory(nextHistory);
          return nextHistory;
        });
      } catch {
        // Offline or network error: carry on with local history
      }
    },
    [pushRemoteHistory],
  );

  // A conversation (and its proposed edits) belongs to one space: pick up that space's history when it changes.
  useEffect(() => {
    stopPayoutRef.current?.();
    abortControllerRef.current?.abort();
    if (syncTimeoutRef.current !== null) window.clearTimeout(syncTimeoutRef.current);
    lastRemoteSnapshotRef.current = "";
    setHistory((prev) => (prev.spaceId === spaceId ? prev : storedHistory(spaceId)));
    setError(null);
    void pullRemoteHistory(spaceId);
  }, [spaceId, pullRemoteHistory]);

  useEffect(() => {
    saveHistory(history);
    const snapshot = JSON.stringify({
      space_id: history.spaceId,
      threads: history.threads,
      active_id: history.activeId,
    });
    if (snapshot !== lastRemoteSnapshotRef.current) {
      if (syncTimeoutRef.current !== null) window.clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = window.setTimeout(() => {
        void pushRemoteHistory(history);
      }, 1000);
    }
  }, [history, pushRemoteHistory]);

  useEffect(() => {
    const handleFocus = () => {
      if (!sendingRef.current) {
        void pullRemoteHistory(spaceId);
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [spaceId, pullRemoteHistory]);

  useEffect(() => {
    return () => {
      stopPayoutRef.current?.();
      abortControllerRef.current?.abort();
      if (syncTimeoutRef.current !== null) window.clearTimeout(syncTimeoutRef.current);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    getJson<{ chat_model?: string }>("/health")
      .then((data) => setModel((picked) => picked ?? (data.chat_model ? bareModel(data.chat_model) : null)))
      .catch(() => {});
    getJson<string[]>("/api/models")
      .then((list) => {
        setModels(list);
        setModel((picked) => {
          if (!picked || list.includes(picked)) return picked;
          localStorage.removeItem(MODEL_KEY);
          return list[0] ?? null;
        });
      })
      .catch(() => {});
  }, []);

  function pickModel(next: string) {
    setModel(next);
    localStorage.setItem(MODEL_KEY, next);
  }

  function pickEffort(next: Effort) {
    setEffort(next);
    localStorage.setItem(EFFORT_KEY, next);
  }

  // Each space has its own slash commands.
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      getJson<SavedPrompt[]>(`/api/prompts?space_id=${spaceId}`, controller.signal)
        .then(setPrompts)
        .catch(() => {});
    setPrompts([]);
    load();
    window.addEventListener(PROMPTS_CHANGED, load);
    return () => {
      controller.abort();
      window.removeEventListener(PROMPTS_CHANGED, load);
    };
  }, [spaceId]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, sending, liveProgress]);
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const multiline = input.includes("\n");
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const adjust = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    adjust();
    let lastWidth = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth !== lastWidth) {
        lastWidth = el.offsetWidth;
        adjust();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [input, multiline]);

  // The command menu is open while the input is a lone "/word" (no space yet).
  const menuItems = useMemo(() => {
    if (menuDismissed || !/^\/\S*$/.test(input)) return [];
    const typed = input.toLowerCase();
    return prompts.filter((p) => p.command.startsWith(typed));
  }, [input, prompts, menuDismissed]);
  const highlighted = Math.min(menuIndex, Math.max(menuItems.length - 1, 0));

  // A question written in from elsewhere (a listen widget's "Summarize Meeting"), ready to be checked and sent.
  useEffect(() => {
    const prompted = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (typeof text !== "string" || !text) return;
      setInput(text);
      setMenuDismissed(true);
      setTimeout(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(text.length, text.length);
        }
      });
    };
    window.addEventListener(CHAT_PROMPT, prompted);
    return () => window.removeEventListener(CHAT_PROMPT, prompted);
  }, []);

  function changeInput(value: string) {
    setInput(value);
    setMenuIndex(0);
    if (!value.startsWith("/")) setMenuDismissed(false);
  }

  function pickCommand(prompt: SavedPrompt) {
    setInput(`${prompt.command} `);
    setMenuDismissed(true);
    inputRef.current?.focus();
  }

  /** The saved prompt a message starts with, if any. */
  function usedPrompt(text: string): UsedPrompt | null {
    const match = COMMAND_RE.exec(text);
    const prompt = match && prompts.find((p) => p.command === match[1].toLowerCase());
    return prompt ? { command: prompt.command, instruction: prompt.instruction, rest: (match[2] ?? "").trim() } : null;
  }

  /** Opens a new conversation with its first turns; returns its id. */
  function startThread(first: Entry[]): string {
    const now = Date.now();
    const thread: ChatThread = { id: newThreadId(), title: threadTitle(first), createdAt: now, updatedAt: now, entries: first };
    setHistory((prev) => ({ ...prev, threads: sortThreads([thread, ...prev.threads]), activeId: thread.id }));
    return thread.id;
  }

  /** Changes a conversation's turns (if it is still in the history); one left with none is dropped. */
  function updateThread(id: string, update: (entries: Entry[]) => Entry[]) {
    setHistory((prev) => {
      const thread = prev.threads.find((t) => t.id === id);
      if (!thread) return prev;
      const next = update(thread.entries);
      if (next.length === 0) {
        const threads = prev.threads.filter((t) => t.id !== id);
        return { ...prev, threads, activeId: prev.activeId === id ? null : prev.activeId };
      }
      const changed = { ...thread, title: threadTitle(next), updatedAt: Date.now(), entries: next };
      return { ...prev, threads: sortThreads(prev.threads.map((t) => (t.id === id ? changed : t))) };
    });
  }

  /** A blank conversation; the one open stays in the history. */
  function startNewChat() {
    setHistory((prev) => ({ ...prev, activeId: null }));
    setError(null);
  }

  function openThread(id: string) {
    setHistory((prev) => ({ ...prev, activeId: id }));
    setError(null);
    setHistoryMenu(false);
  }

  function deleteThread(id: string) {
    setHistory((prev) => ({
      ...prev,
      threads: prev.threads.filter((t) => t.id !== id),
      activeId: prev.activeId === id ? null : prev.activeId,
    }));
    if (id === history.activeId) setError(null);
  }

  /** Upload files to the space's assets, to go with the question being written. */
  async function attachFiles(files: File[]) {
    if (!files.length) return;
    setAttachError(null);
    await Promise.all(
      files.map(async (file) => {
        const id = newThreadId();
        setUploading((all) => [...all, { id, name: file.name }]);
        try {
          const { url } = await uploadFile(spaceId, file);
          const attachment = { name: file.name, url, size: file.size, content_type: file.type || null };
          setPendingAttachments((all) => [...all, attachment]);
        } catch (err) {
          setAttachError(`Could not attach ${file.name} (${message(err)}).`);
        } finally {
          setUploading((all) => all.filter((u) => u.id !== id));
        }
      }),
    );
  }

  /** Files pasted in the input are attached; pasted text is typed as usual. */
  function handlePaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    void attachFiles(files);
  }

  function handleDrop(e: ReactDragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragOver(false);
    void attachFiles(Array.from(e.dataTransfer.files));
  }

  /** A PDF or image attachment opens in the lightbox; any other file is downloaded. */
  function openAttachment(attachment: ChatAttachment) {
    if (isPdfUrl(attachment.url) || isImageAttachment(attachment)) {
      setOpenedAttachment(attachment);
      return;
    }
    const link = document.createElement("a");
    link.href = attachment.url;
    link.download = attachment.name;
    link.click();
  }

  async function send() {
    const text = input.trim();
    const attachments = pendingAttachments;
    if ((!text && !attachments.length) || sending || uploading.length) return;
    const question: Entry = { role: "user", content: text, prompt: usedPrompt(text), context: context.hint, attachments };
    const next: Entry[] = [...entries, question];
    const threadId = activeThread?.id ?? startThread(next);
    if (activeThread) updateThread(threadId, () => next);
    setInput("");
    setPendingAttachments([]);
    setAttachError(null);
    setMenuDismissed(false);
    setError(null);
    setSending(true);
    setLiveProgress(NO_PROGRESS);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    stopPayoutRef.current = null;
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map((entry) => ({
            role: entry.role,
            content: historyContent(entry),
            attachments: entry.role === "user" ? (entry.attachments ?? []) : [],
          })),
          access_mode: mode,
          space_id: spaceId,
          note_path: context.notePath,
          model: model ?? undefined,
          reasoning_effort: effort === "auto" ? null : effort,
        }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));

      const toolArgs = new Map<string, Record<string, unknown>>();
      let latestProgress: LiveProgress = { ...NO_PROGRESS, phase: "thinking" };

      const body = await readResponse(res, (event) => {
        if (event.type === "tool_start" && event.arguments) {
          toolArgs.set(event.id, event.arguments);
        } else if (event.type === "tool_end" && event.name === "write_note" && event.ok) {
          const args = toolArgs.get(event.id);
          const p = args?.path;
          if (typeof p === "string") notifyNoteUpdated(spaceId, p);
        }
        setLiveProgress((progress) => {
          const nextProg = progressWith(progress ?? NO_PROGRESS, event);
          latestProgress = nextProg;
          return nextProg;
        });
      });

      if (body.written_paths && body.written_paths.length > 0) {
        for (const p of body.written_paths) {
          notifyNoteUpdated(spaceId, p);
        }
      }

      // If the response arrived in bulk without live token streaming, pay out progressively
      if (body.reply && latestProgress.streamingText.trim() !== body.reply.trim()) {
        setLiveProgress((prev) => ({
          ...(prev ?? NO_PROGRESS),
          phase: "answering",
        }));
        await payoutReply(
          body.reply,
          (currentText) => {
            setLiveProgress((prev) => ({
              ...(prev ?? NO_PROGRESS),
              phase: "answering",
              streamingText: currentText,
            }));
          },
          controller.signal,
          (cancelFn) => {
            stopPayoutRef.current = cancelFn;
          },
        );
        stopPayoutRef.current = null;
      }

      // Finished phase: show finished indicator for 400ms before adding to transcript
      setLiveProgress((prev) => ({
        ...(prev ?? NO_PROGRESS),
        phase: "finished",
        streamingText: body.reply,
      }));
      await new Promise((resolve) => setTimeout(resolve, 400));

      updateThread(threadId, (prev) => [
        ...prev,
        {
          role: "assistant",
          content: body.reply,
          edits: body.proposed_edits.map((edit) => ({ ...edit, status: { state: "pending" } })),
          written: body.written_paths,
          toolCalls: body.tool_calls,
        },
      ]);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "AbortError") {
        // Stopped on purpose: keep the question in the chat, from where it can be edited and sent again.
        setError(null);
        return;
      }
      // Put the question back so it can be retried without two user turns in a row (a new chat's thread goes away).
      updateThread(threadId, () => entries);
      setInput(text);
      setPendingAttachments(attachments);
      setError(message(err));
    } finally {
      stopPayoutRef.current = null;
      setSending(false);
      setLiveProgress(null);
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  }

  function stop() {
    if (stopPayoutRef.current) {
      stopPayoutRef.current();
      stopPayoutRef.current = null;
      return;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }

  /**
   * Copies a reply as formatted HTML (rendered in `container`, its math cleaned as `cleanMathForClipboard` does), for
   * pasting into a note, and as its markdown.
   */
  async function copyReply(index: number, text: string, container?: HTMLElement | null) {
    try {
      if (!container || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("no rich copy");
      const clone = container.cloneNode(true) as HTMLElement;
      cleanMathForClipboard(clone);
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([clone.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
    }
    setCopiedIndex(index);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedIndex(null);
      copiedTimerRef.current = null;
    }, 2000);
  }

  /** Puts a past question back in the input, cursor at the end, to be changed and sent again. */
  function editPrompt(entry: Extract<Entry, { role: "user" }>) {
    const text = entry.prompt ? `${entry.prompt.command}${entry.prompt.rest ? ` ${entry.prompt.rest}` : ""}` : entry.content;
    setInput(text);
    setPendingAttachments(entry.attachments ?? []);
    setMenuDismissed(true);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(text.length, text.length);
      }
    }, 0);
  }

  function setEditStatus(threadId: string, entryIndex: number, path: string, status: EditStatus) {
    updateThread(threadId, (prev) =>
      prev.map((entry, i) =>
        i === entryIndex && entry.role === "assistant"
          ? { ...entry, edits: entry.edits.map((e) => (e.path === path ? { ...e, status } : e)) }
          : entry,
      ),
    );
  }

  async function approve(threadId: string, entryIndex: number, edit: Edit) {
    setEditStatus(threadId, entryIndex, edit.path, { state: "applying" });
    try {
      const res = await fetch("/api/notes/apply-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          space_id: spaceId,
          path: edit.path,
          content: edit.content,
          frontmatter: edit.frontmatter,
          base_hash: edit.base_hash,
        }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      setEditStatus(threadId, entryIndex, edit.path, { state: "applied" });
      notifyNoteUpdated(spaceId, edit.path);
    } catch (err: unknown) {
      setEditStatus(threadId, entryIndex, edit.path, { state: "error", message: message(err) });
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuItems.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMenuIndex((highlighted + step + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(menuItems[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <section aria-label="Ask the knowledge base" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border-default px-3.5 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-text-secondary">Ask the knowledge base</h2>
        <div className="flex items-center gap-1">
          <HeaderButton label="New chat" onClick={startNewChat} disabled={sending || !activeThread}>
            <PlusIcon />
          </HeaderButton>
          <HeaderButton
            buttonRef={historyButtonRef}
            label="Chat history"
            onClick={() => setHistoryMenu((open) => !open)}
            expanded={historyMenu}
          >
            <HistoryIcon />
          </HeaderButton>
          <Popover
            anchor={historyButtonRef}
            open={historyMenu}
            onClose={() => setHistoryMenu(false)}
            label="Chat history"
            role="dialog"
            align="end"
            className="w-72"
          >
            <div className="border-b border-border-default px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Chat history
            </div>
            {history.threads.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-text-muted">No past conversations yet.</p>
            ) : (
              <div className="max-h-80 overflow-y-auto py-1">
                {history.threads.map((thread) => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    active={thread.id === history.activeId}
                    disabled={sending}
                    onOpen={() => openThread(thread.id)}
                    onDelete={() => deleteThread(thread.id)}
                  />
                ))}
              </div>
            )}
          </Popover>
          <PinButton pinned={pinned} onClick={() => onPinnedChange(!pinned)} />
          <AssistantButton label="Close AI Assistant" onClick={onCollapse} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-2.5 text-xs">
        {entries.length === 0 && (
          <p className="text-xs text-text-muted">
            Ask about your projects and notes, e.g. “What is overdue on C7801?”. Type <span className="font-mono">/</span>{" "}
            for your saved commands.
          </p>
        )}
        {activeThread?.entries.map((entry, i) =>
          entry.role === "user" ? (
            <div key={i} className="group flex max-w-[85%] flex-col items-end gap-1 self-end">
              {!!entry.attachments?.length && (
                <div className="flex flex-wrap justify-end gap-1">
                  {entry.attachments.map((attachment) => (
                    <AttachmentPill key={attachment.url} attachment={attachment} onOpen={() => openAttachment(attachment)} />
                  ))}
                </div>
              )}
              {(entry.prompt || entry.content) && (
                <div className="whitespace-pre-wrap rounded-lg bg-surface-active px-2.5 py-1.5 text-xs leading-relaxed">
                  {entry.prompt ? (
                    <>
                      <span className="font-mono text-accent" title={entry.prompt.instruction}>
                        {entry.prompt.command}
                      </span>
                      {entry.prompt.rest && ` ${entry.prompt.rest}`}
                    </>
                  ) : (
                    entry.content
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => editPrompt(entry)}
                title="Edit prompt"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted opacity-60 hover:bg-surface-raised hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
              >
                <PencilIcon />
                Edit
              </button>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-2">
              <div className="rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-xs leading-relaxed text-text-secondary">
                {entry.toolCalls.length > 0 && <ToolCalls calls={entry.toolCalls} />}
                <div className="markdown" onCopy={copyCleanSelection}>
                  <ChatMarkdown content={entry.content} />
                </div>
                {entry.written.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {entry.written.map((path) => (
                      <Link key={path} to={notePath(spaceId, path)} className="chip" title={path}>
                        <span className="h-1.5 w-1.5 rounded-full bg-project-p5002" />
                        Wrote {path.split("/").pop()}
                      </Link>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                    <CheckIcon className="h-3 w-3 text-project-p5002 shrink-0" />
                    Finished answering
                  </span>
                  <button
                    type="button"
                    onClick={(e) =>
                      copyReply(i, entry.content, e.currentTarget.closest(".rounded-lg")?.querySelector<HTMLElement>(".markdown"))
                    }
                    title="Copy response"
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-surface-active hover:text-text-primary"
                  >
                    {copiedIndex === i ? <CheckIcon /> : <CopyIcon />}
                    {copiedIndex === i ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              {entry.edits.map((edit) => (
                <EditCard
                  key={edit.path}
                  edit={edit}
                  onApprove={() => approve(activeThread.id, i, edit)}
                  onReject={() => setEditStatus(activeThread.id, i, edit.path, { state: "rejected" })}
                />
              ))}
            </div>
          ),
        )}
        {sending && <LiveActivityCard progress={liveProgress ?? NO_PROGRESS} onStop={stop} />}
        {error && <p className="text-xs text-accent">Could not get an answer ({error}).</p>}
        <div ref={bottomRef} />
      </div>

      <div
        className={`flex flex-col gap-1.5 border-t px-3.5 pb-3 pt-2 ${dragOver ? "border-accent bg-accent/5" : "border-border-default"}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={handleDrop}
        data-testid="chat-composer"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            ref={modelButtonRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={modelMenu}
            onClick={() => setModelMenu((open) => !open)}
            disabled={sending || (!model && !models.length)}
            className="btn !min-h-[24px] h-6 gap-1.5 !px-2 !text-[11px] font-medium text-text-primary hover:bg-surface-hover"
            title="Select model"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${model ? "bg-project-p5002" : "bg-project-neutral"}`} />
            <span className="max-w-[12rem] truncate">{model ?? "Model"}</span>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <Popover
            anchor={modelButtonRef}
            open={modelMenu}
            onClose={() => setModelMenu(false)}
            label="Select model"
            role="listbox"
            className="w-64 max-h-80 overflow-y-auto"
          >
            {MODEL_GROUPS.map((group, index) => {
              const names = models.filter(group.matches);
              if (!names.length) return null;
              return (
                <div key={group.label} role="group" aria-label={group.label}>
                  <div
                    className={`flex items-baseline justify-between gap-2 border-b border-border-default px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted ${
                      index > 0 ? "border-t" : ""
                    }`}
                  >
                    <span>{group.label}</span>
                    <span className="text-[10px] font-normal normal-case tracking-normal text-project-p5002">{group.badge}</span>
                  </div>
                  <div className="py-1">
                    {names.map((name) => {
                      const isSelected = name === model;
                      return (
                        <button
                          key={name}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => {
                            pickModel(name);
                            setModelMenu(false);
                          }}
                          className={`flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
                            isSelected ? "bg-accent/20 font-medium text-accent-soft" : "text-text-primary hover:bg-surface-hover"
                          }`}
                        >
                          <span className="truncate">{name}</span>
                          {isSelected && (
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
                              <path d="M3.5 8.5l3 3 6-6" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </Popover>
          <button
            ref={effortButtonRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={effortMenu}
            onClick={() => setEffortMenu((open) => !open)}
            disabled={sending}
            className="btn !min-h-[24px] h-6 gap-1 !px-2 !text-[11px] font-medium text-text-primary hover:bg-surface-hover"
            title="Reasoning effort"
          >
            <BrainIcon />
            <span>{effort === "auto" ? "Auto" : EFFORTS.find((e) => e.value === effort)?.label}</span>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <Popover
            anchor={effortButtonRef}
            open={effortMenu}
            onClose={() => setEffortMenu(false)}
            label="Reasoning effort"
            role="listbox"
            className="w-60"
          >
            <div className="border-b border-border-default px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Reasoning effort
            </div>
            <div className="py-1">
              {EFFORTS.map((option) => {
                const isSelected = option.value === effort;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      pickEffort(option.value);
                      setEffortMenu(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
                      isSelected ? "bg-accent/20 text-accent-soft" : "text-text-primary hover:bg-surface-hover"
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{option.label}</span>
                      <span className="truncate text-text-muted">{option.hint}</span>
                    </span>
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
                        <path d="M3.5 8.5l3 3 6-6" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </Popover>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Access to notes">
            {MODES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={`${mode === value ? "seg-on" : "seg"} !min-h-[22px] h-[22px] !px-2 !text-[10px]`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={startNewChat}
            disabled={sending || !activeThread}
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-surface-raised hover:text-text-primary disabled:opacity-40"
          >
            New chat
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <span className="chip !px-2 !py-0.5 !text-[10px]">Space: {space?.name ?? "…"}</span>
          <span className="chip !px-2 !py-0.5 !text-[10px]">Context: {context.label}</span>
          <span className="chip !px-2 !py-0.5 !text-[10px]">{MODE_CHIP[mode]}</span>
        </div>
        {(pendingAttachments.length > 0 || uploading.length > 0) && (
          <div className="flex flex-wrap gap-1" aria-label="Attached files">
            {pendingAttachments.map((attachment) => (
              <AttachmentPill
                key={attachment.url}
                attachment={attachment}
                onOpen={() => openAttachment(attachment)}
                onRemove={() => setPendingAttachments((all) => all.filter((a) => a.url !== attachment.url))}
              />
            ))}
            {uploading.map((upload) => (
              <span key={upload.id} role="status" className="chip !px-2 !py-0.5 !text-[11px] text-text-muted">
                <SpinnerIcon />
                <span className="max-w-[10rem] truncate">{upload.name}</span>
              </span>
            ))}
          </div>
        )}
        {attachError && <p className="text-[11px] text-accent">{attachError}</p>}
        <div className="relative flex items-end gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(e) => {
              void attachFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files (or drop or paste them here)"
            className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text-primary"
          >
            <PaperclipIcon />
          </button>
          {menuItems.length > 0 && (
            <CommandMenu items={menuItems} highlighted={highlighted} onPick={pickCommand} onHover={setMenuIndex} />
          )}
          <label className="flex-1">
            <span className="sr-only">Ask a question</span>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => changeInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={multiline ? 3 : 1}
              placeholder="Ask, or type / for commands"
              className={`block min-h-9 w-full resize-none rounded-lg ${multiline ? "" : "overflow-hidden"} border border-border-light bg-surface-raised px-2.5 py-1.5 text-xs leading-5 placeholder:text-text-muted focus:border-accent/70 focus:outline-none`}
              aria-autocomplete="list"
              aria-expanded={menuItems.length > 0}
            />
          </label>
          {sending ? (
            <button
              type="button"
              onClick={stop}
              className="btn !min-h-9 h-9 gap-1 border-accent/40 bg-accent/10 !px-2.5 !text-xs text-accent hover:bg-accent/20"
            >
              <StopIcon />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={(!input.trim() && !pendingAttachments.length) || uploading.length > 0}
              aria-label="Send"
              title="Send"
              className="btn-primary !min-h-9 h-9 w-9 shrink-0 !rounded-full !p-0"
            >
              <SendChevronIcon />
            </button>
          )}
        </div>
      </div>
      {openedAttachment && (
        <MediaLightbox src={openedAttachment.url} title={openedAttachment.name} onClose={() => setOpenedAttachment(null)} />
      )}
    </section>
  );
}

const IMAGE_SUFFIX_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Whether an attachment is an image, which the lightbox shows. */
function isImageAttachment(attachment: ChatAttachment): boolean {
  return !!attachment.content_type?.startsWith("image/") || IMAGE_SUFFIX_RE.test(new URL(attachment.url, window.location.href).pathname);
}

/** A file's size, e.g. "820 B", "14 KB" or "2.3 MB". */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An attached file: its icon, name and size, opened on click; with a × to remove it, in the composer. */
function AttachmentPill({ attachment, onOpen, onRemove }: { attachment: ChatAttachment; onOpen: () => void; onRemove?: () => void }) {
  const kind = isPdfUrl(attachment.url) ? "pdf" : isImageAttachment(attachment) ? "image" : "file";
  return (
    <span className="chip !gap-1 !px-1.5 !py-0.5 !text-[11px]" data-attachment={attachment.name}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${attachment.name}`}
        title={`Open ${attachment.name}`}
        className="flex min-w-0 items-center gap-1 hover:text-text-primary"
      >
        <FileIcon kind={kind} />
        <span className="max-w-[10rem] truncate">{attachment.name}</span>
        {attachment.size != null && <span className="shrink-0 text-text-muted">{fileSize(attachment.size)}</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          title="Remove"
          className="ml-0.5 rounded px-0.5 text-text-muted hover:bg-surface-active hover:text-text-primary"
        >
          ×
        </button>
      )}
    </span>
  );
}

function FileIcon({ kind }: { kind: "pdf" | "image" | "file" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${kind === "pdf" ? "text-accent" : "text-text-muted"}`} aria-hidden>
      {kind === "image" ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="M21 15l-5-5L5 21" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </>
      )}
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

const MODE_CHIP: Record<AccessMode, string> = {
  read_only: "Notes: read only",
  ask_first: "Notes: asks before writing",
  write_directly: "Notes: read and write",
};

function BrainIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted" aria-hidden>
      <path d="M9.5 3A2.5 2.5 0 0 0 7 5.5v.1A3 3 0 0 0 4.5 10a3 3 0 0 0 .4 5.4A3 3 0 0 0 9.5 19a2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 9.5 3z" />
      <path d="M14.5 3A2.5 2.5 0 0 1 17 5.5v.1a3 3 0 0 1 2.5 4.4 3 3 0 0 1-.4 5.4 3 3 0 0 1-4.6 3.6 2.5 2.5 0 0 1-2.5-2.5" />
    </svg>
  );
}

function SendChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M6 3.5l4.5 4.5L6 12.5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ className = "shrink-0 text-project-p5002" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3.5 8.5l3 3 6-6" />
    </svg>
  );
}

function SpinnerIcon({ className = "h-3 w-3 shrink-0 animate-spin text-accent" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
      <circle cx="8" cy="8" r="6" strokeOpacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="shrink-0" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function PencilIcon({ className = "shrink-0" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function CommandMenu({
  items,
  highlighted,
  onPick,
  onHover,
}: {
  items: SavedPrompt[];
  highlighted: number;
  onPick: (prompt: SavedPrompt) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Saved commands"
      className="absolute inset-x-0 bottom-full z-20 mb-1.5 overflow-hidden rounded-xl border border-border-strong bg-surface-active p-1.5 shadow-xl shadow-black/40"
    >
      {items.map((prompt, i) => (
        <button
          key={prompt.id}
          type="button"
          role="option"
          aria-selected={i === highlighted}
          // Keep focus in the textarea.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(prompt)}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left ${
            i === highlighted ? "bg-surface-active" : ""
          }`}
        >
          <span className="flex w-full items-baseline gap-2">
            <span className="font-mono text-xs text-accent">{prompt.command}</span>
            <span className="truncate text-xs text-text-primary">{prompt.description}</span>
          </span>
          <span className="line-clamp-1 text-[11px] text-text-muted">{prompt.instruction}</span>
        </button>
      ))}
      <div className="mx-1.5 my-1 h-px bg-border-strong" />
      <Link
        to="/space-preferences#commands"
        onMouseDown={(e) => e.preventDefault()}
        className="block rounded-md px-3 py-1.5 text-xs text-text-muted hover:bg-surface-active hover:text-text-primary"
      >
        Manage commands…
      </Link>
    </div>
  );
}

function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <details className="mb-2 text-[11px] text-text-muted">
      <summary className="cursor-pointer select-none">
        Used {calls.length} tool{calls.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {calls.map((call, i) => (
          <ToolStep key={i} name={call.name} args={call.arguments} status={call.ok ? "ok" : "error"} />
        ))}
      </ul>
    </details>
  );
}

/** One tool call, in words, with whether it is running, done or failed (its raw call in the tooltip). */
function ToolStep({ name, args, status }: { name: string; args: Record<string, unknown>; status: LiveToolCall["status"] }) {
  const { action, target } = describeToolCall(name, args);
  return (
    <li className="flex min-w-0 items-center gap-1.5" title={rawToolCall(name, args)}>
      {status === "running" ? (
        <SpinnerIcon />
      ) : status === "ok" ? (
        <CheckIcon />
      ) : (
        <span className="w-3 shrink-0 text-center leading-none text-red-400" aria-label="failed">
          ✕
        </span>
      )}
      <span className="shrink-0 text-text-secondary">{action}</span>
      {target && <span className="min-w-0 truncate font-mono text-text-muted">{target}</span>}
    </li>
  );
}

/** What the agent is doing while it answers: its current step, latest thought, steps so far and reply so far. */
function LiveActivityCard({ progress, onStop }: { progress: LiveProgress; onStop: () => void }) {
  const { thoughtSubject, thoughtText, tools, streamingText, phase } = progress;
  const running = [...tools].reverse().find((t) => t.status === "running");

  let statusText = "Thinking…";
  let badgeLabel = "Thinking";
  if (phase === "finished") {
    statusText = "Finished answering";
    badgeLabel = "Finished";
  } else if (phase === "answering") {
    statusText = "Answering…";
    badgeLabel = "Writing response";
  } else if (running) {
    const { action, target } = describeToolCall(running.name, running.arguments);
    statusText = target ? `${action}: ${target}…` : `${action}…`;
    badgeLabel = "Researching";
  } else if (thoughtSubject) {
    statusText = `${thoughtSubject}…`;
    badgeLabel = "Thinking";
  } else if (tools.length > 0) {
    badgeLabel = "Researching";
  }

  // Note blocks are carried out (or proposed) once the reply is done, not shown as text.
  const preview = streamingText.replace(/<write_note[\s\S]*?(?:<\/write_note>|$)/g, "").trim();

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-xs leading-relaxed text-text-secondary"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-2">
        {phase === "finished" ? (
          <CheckIcon className="h-3.5 w-3.5 text-project-p5002 shrink-0" />
        ) : phase === "answering" ? (
          <PencilIcon className="h-3.5 w-3.5 text-accent animate-pulse shrink-0" />
        ) : (
          <SpinnerIcon className="h-3 w-3 shrink-0 animate-spin text-accent" />
        )}
        <span
          className={`min-w-0 truncate text-xs ${
            phase === "finished"
              ? "font-medium text-project-p5002"
              : phase === "answering"
                ? "font-semibold text-text-primary"
                : "font-medium text-text-primary"
          }`}
        >
          {statusText}
        </span>
        <span
          className={`chip text-[10px] ${
            phase === "finished"
              ? "bg-project-p5002/15 text-project-p5002"
              : phase === "answering"
                ? "bg-accent/15 text-accent"
                : "bg-surface-active text-text-muted"
          }`}
        >
          {badgeLabel}
        </span>
        {tools.length > 0 && phase === "thinking" && (
          <span className="shrink-0 text-[10px] text-text-muted">
            {tools.length} step{tools.length === 1 ? "" : "s"}
          </span>
        )}
        {phase !== "finished" && (
          <button
            type="button"
            onClick={onStop}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-surface-active hover:text-text-primary"
          >
            <StopIcon />
            Stop
          </button>
        )}
      </div>
      {thoughtText && phase === "thinking" && (
        <div className="markdown line-clamp-2 border-l-2 border-accent/40 pl-2 text-[11px] text-text-muted" onCopy={copyCleanSelection}>
          <ChatMarkdown content={thoughtText} />
        </div>
      )}
      {tools.length > 0 && (
        <ul className="max-h-36 space-y-1 overflow-y-auto border-t border-border-default/60 pt-1.5 text-[11px]">
          {tools.map((tool, i) => (
            <ToolStep key={`${tool.id}-${i}`} name={tool.name} args={tool.arguments} status={tool.status} />
          ))}
        </ul>
      )}
      {preview ? (
        <div className="markdown border-t border-border-default pt-2" onCopy={copyCleanSelection}>
          <ChatMarkdown content={preview} />
          {phase === "answering" && (
            <span className="inline-block text-accent animate-pulse ml-0.5 select-none" aria-hidden="true">
              ●
            </span>
          )}
        </div>
      ) : (
        phase === "answering" && (
          <div className="border-t border-border-default pt-2 text-[11px] text-text-muted italic flex items-center gap-1.5">
            <span>Writing response…</span>
            <span className="inline-block text-accent animate-pulse select-none" aria-hidden="true">
              ●
            </span>
          </div>
        )
      )}
    </div>
  );
}

const EDIT_STATUS: Record<EditStatus["state"], { label: string; dot: string }> = {
  pending: { label: "Waiting for approval", dot: "bg-accent" },
  applying: { label: "Saving…", dot: "bg-accent" },
  applied: { label: "Written to note", dot: "bg-project-p5002" },
  rejected: { label: "Rejected", dot: "bg-project-neutral" },
  error: { label: "Could not save", dot: "bg-red-400" },
};

function EditCard({ edit, onApprove, onReject }: { edit: Edit; onApprove: () => void; onReject: () => void }) {
  const { state } = edit.status;
  const isNew = edit.previous_content === null;
  const before = isNew ? "" : noteText(edit.previous_content ?? "", edit.previous_frontmatter ?? {});
  const after = noteText(edit.content, edit.frontmatter);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-light bg-surface-panel px-3.5 py-3 text-xs text-text-secondary">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-text-muted">{isNew ? "NEW NOTE" : "NOTE EDIT"}</span>
        <span className="chip">
          <span className={`h-2 w-2 rounded-full ${EDIT_STATUS[state].dot}`} />
          {EDIT_STATUS[state].label}
        </span>
      </div>
      <div className="break-all font-mono text-xs text-text-muted">{edit.path.split("/").join(" / ")}</div>
      <details open={state === "pending"} className="text-xs">
        <summary className="cursor-pointer select-none text-text-muted">Changes</summary>
        <div className="mt-1.5 overflow-hidden rounded-lg border border-border-default bg-background">
          <Diff before={before} after={after} />
        </div>
      </details>
      {edit.status.state === "error" && <span className="text-xs text-accent">{edit.status.message}</span>}
      {(state === "pending" || state === "applying" || state === "error") && (
        <div className="flex gap-2">
          <button type="button" onClick={onApprove} disabled={state === "applying"} className="btn-primary">
            {state === "applying" ? "Saving…" : "Approve"}
          </button>
          <button type="button" onClick={onReject} disabled={state === "applying"} className="btn">
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/** The note as it reads on disk: a simple front-matter block, then the content. */
function noteText(content: string, frontmatter: Frontmatter): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return content;
  const lines = keys.map((k) => {
    const v = frontmatter[k];
    return `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
  });
  return `---\n${lines.join("\n")}\n---\n${content}`;
}

type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line diff via longest common subsequence; notes are small enough for the O(n·m) table. */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

const LINE_STYLE: Record<DiffLine["kind"], string> = {
  same: "text-text-muted",
  add: "bg-project-p5002/10 text-project-p5002",
  del: "bg-red-400/10 text-red-300 line-through decoration-red-400/40",
};
const LINE_MARK: Record<DiffLine["kind"], string> = { same: " ", add: "+", del: "−" };

function Diff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  // Show changed lines with a little context; fold long unchanged stretches.
  const near = lines.map((_, idx) =>
    lines.slice(Math.max(0, idx - CONTEXT_LINES), idx + CONTEXT_LINES + 1).some((l) => l.kind !== "same"),
  );
  const rows: ({ fold: number } | DiffLine)[] = [];
  lines.forEach((line, idx) => {
    if (near[idx]) rows.push(line);
    else if (rows.length > 0 && "fold" in rows[rows.length - 1]) (rows[rows.length - 1] as { fold: number }).fold++;
    else rows.push({ fold: 1 });
  });

  return (
    <pre className="max-h-80 overflow-auto py-1 font-mono text-xs leading-5">
      {rows.map((row, idx) =>
        "fold" in row ? (
          <div key={idx} className="px-3 text-text-muted/70">
            ⋯ {row.fold} unchanged line{row.fold === 1 ? "" : "s"}
          </div>
        ) : (
          <div key={idx} className={`whitespace-pre-wrap px-3 ${LINE_STYLE[row.kind]}`}>
            {LINE_MARK[row.kind]} {row.text}
          </div>
        ),
      )}
    </pre>
  );
}

/** A square icon button in the chat's header, beside the pin. */
function HeaderButton({
  label,
  onClick,
  disabled = false,
  expanded,
  buttonRef,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  buttonRef?: RefObject<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      title={label}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-light bg-surface-raised text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:hover:text-text-secondary"
    >
      {children}
    </button>
  );
}

/** A past conversation in the chat history: opens it, or deletes it. */
function ThreadItem({
  thread,
  active,
  disabled,
  onOpen,
  onDelete,
}: {
  thread: ChatThread;
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const count = thread.entries.length;
  return (
    <div
      className={`group flex items-center gap-1 rounded transition-colors ${
        active ? "bg-accent/20" : "hover:bg-surface-hover"
      }`}
    >
      <button
        type="button"
        aria-current={active || undefined}
        onClick={onOpen}
        disabled={disabled}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5 text-left disabled:cursor-default"
      >
        <span className={`w-full truncate text-xs ${active ? "font-medium text-accent-soft" : "text-text-primary"}`}>
          {thread.title}
        </span>
        <span className="text-[11px] text-text-muted">
          {relativeTime(thread.updatedAt)} · {count} message{count === 1 ? "" : "s"}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={disabled && active}
        aria-label={`Delete “${thread.title}”`}
        title="Delete conversation"
        className="mr-1 shrink-0 rounded p-1 text-text-muted opacity-60 hover:bg-surface-active hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

/** Toggles whether the chat stays expanded when a task opens. */
function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  const label = pinned ? "Unpin chat" : "Pin chat (keep open when a task opens)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pinned}
      aria-label={label}
      title={label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
        pinned
          ? "border-accent/60 bg-surface-active text-accent"
          : "border-border-light bg-surface-raised text-text-secondary hover:text-text-primary"
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill={pinned ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </svg>
    </button>
  );
}
