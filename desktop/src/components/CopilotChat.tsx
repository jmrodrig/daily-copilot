import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import { Link, useLocation, type Location } from "react-router-dom";
import remarkGfm from "remark-gfm";

import { errorDetail, getJson, message, PROMPTS_CHANGED, type SavedPrompt } from "../lib/api";
import { notePath, useSpace } from "../lib/space";
import { IconButton } from "./Sidebar";

// Shapes of POST /api/chat and POST /api/notes/apply-edit (see ChatResponse etc. in backend/schemas.py).
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

type EditStatus =
  | { state: "pending" }
  | { state: "applying" }
  | { state: "applied" }
  | { state: "rejected" }
  | { state: "error"; message: string };
type Edit = ProposedEdit & { status: EditStatus };
/** A saved prompt used at the start of a message, e.g. "/prep Friday design review". */
type UsedPrompt = { command: string; instruction: string; rest: string };
type Entry =
  | { role: "user"; content: string; prompt: UsedPrompt | null; context: string | null }
  | { role: "assistant"; content: string; edits: Edit[]; written: string[]; toolCalls: ToolCall[] };

const MODES: { value: AccessMode; label: string }[] = [
  { value: "read_only", label: "Read only" },
  { value: "ask_first", label: "Ask first" },
  { value: "write_directly", label: "Write directly" },
];
const MODE_KEY = "copilot.accessMode";
const CONTEXT_LINES = 3;
const COMMAND_RE = /^(\/[a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

function storedMode(): AccessMode {
  const value = localStorage.getItem(MODE_KEY);
  return MODES.some((m) => m.value === value) ? (value as AccessMode) : "ask_first";
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
    "/settings": "Settings",
    "/emails": "Forwarded emails",
    "/graph": "Notes graph",
    "/people": "People",
  };
  return { label: labels[pathname] ?? "Wiki", hint: null, notePath: null };
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

export default function CopilotChat({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AccessMode>(storedMode);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();
  const { spaceId, space } = useSpace();
  const context = pageContext(location, spaceId);

  // A conversation (and its proposed edits) belongs to one space: start over when it changes.
  useEffect(() => {
    setEntries([]);
    setError(null);
  }, [spaceId]);

  useEffect(() => {
    getJson<{ chat_model?: string }>("/health")
      .then((data) => setModel(data.chat_model ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const load = () =>
      getJson<SavedPrompt[]>("/api/prompts")
        .then(setPrompts)
        .catch(() => {});
    load();
    window.addEventListener(PROMPTS_CHANGED, load);
    return () => window.removeEventListener(PROMPTS_CHANGED, load);
  }, []);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, sending]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The command menu is open while the input is a lone "/word" (no space yet).
  const menuItems = useMemo(() => {
    if (menuDismissed || !/^\/\S*$/.test(input)) return [];
    const typed = input.toLowerCase();
    return prompts.filter((p) => p.command.startsWith(typed));
  }, [input, prompts, menuDismissed]);
  const highlighted = Math.min(menuIndex, Math.max(menuItems.length - 1, 0));
  const multiline = input.includes("\n");

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

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const next: Entry[] = [...entries, { role: "user", content: text, prompt: usedPrompt(text), context: context.hint }];
    setEntries(next);
    setInput("");
    setMenuDismissed(false);
    setError(null);
    setSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map((entry) => ({ role: entry.role, content: historyContent(entry) })),
          access_mode: mode,
          space_id: spaceId,
          note_path: context.notePath,
        }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      const body: ChatResponse = await res.json();
      setEntries((prev) => [
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
      // Put the question back so it can be retried without two user turns in a row.
      setEntries(entries);
      setInput(text);
      setError(message(err));
    } finally {
      setSending(false);
    }
  }

  function setEditStatus(entryIndex: number, path: string, status: EditStatus) {
    setEntries((prev) =>
      prev.map((entry, i) =>
        i === entryIndex && entry.role === "assistant"
          ? { ...entry, edits: entry.edits.map((e) => (e.path === path ? { ...e, status } : e)) }
          : entry,
      ),
    );
  }

  async function approve(entryIndex: number, edit: Edit) {
    setEditStatus(entryIndex, edit.path, { state: "applying" });
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
      setEditStatus(entryIndex, edit.path, { state: "applied" });
    } catch (err: unknown) {
      setEditStatus(entryIndex, edit.path, { state: "error", message: message(err) });
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

  if (!open) {
    return (
      <aside
        aria-label="Ask the knowledge base"
        className="flex w-16 shrink-0 flex-col items-center border-l border-border-default bg-surface-panel py-3.5"
      >
        <IconButton label="Expand chat" onClick={() => onOpenChange(true)} direction="left" />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Ask the knowledge base"
      className="flex w-[320px] shrink-0 flex-col border-l border-border-default bg-surface-panel"
    >
      <div className="flex items-center justify-between pb-2.5 pl-5 pr-3 pt-3.5">
        <h2 className="text-base font-semibold">Ask the knowledge base</h2>
        <IconButton label="Collapse chat" onClick={() => onOpenChange(false)} direction="right" />
      </div>

      <div className="flex flex-col gap-2.5 px-5 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="btn min-h-[34px] cursor-default hover:bg-transparent" title={model ?? undefined}>
            <span className={`h-2 w-2 rounded-full ${model ? "bg-project-p5002" : "bg-project-neutral"}`} />
            {model ? model.split("/").pop() : "Model"}
          </span>
          <button
            type="button"
            onClick={() => {
              setEntries([]);
              setError(null);
            }}
            disabled={sending || entries.length === 0}
            className="ml-auto rounded-md px-2 py-1 text-xs text-text-muted hover:bg-surface-raised hover:text-text-primary disabled:opacity-40"
          >
            Clear
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Access to notes">
          {MODES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={`${mode === value ? "seg-on" : "seg"} !min-h-8 !px-3 !text-xs`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-3 pt-1">
        <div className="flex flex-wrap gap-1.5">
          <span className="chip">Space: {space?.name ?? "…"}</span>
          <span className="chip">Context: {context.label}</span>
          <span className="chip">{MODE_CHIP[mode]}</span>
        </div>
        {entries.length === 0 && (
          <p className="text-[13px] text-text-muted">
            Ask about your projects and notes, e.g. “What is overdue on C7801?”. Type <span className="font-mono">/</span>{" "}
            for your saved commands.
          </p>
        )}
        {entries.map((entry, i) =>
          entry.role === "user" ? (
            <div
              key={i}
              className="max-w-[85%] self-end whitespace-pre-wrap rounded-xl bg-surface-active px-3.5 py-2.5 text-sm"
            >
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
          ) : (
            <div key={i} className="flex flex-col gap-2">
              <div className="rounded-xl border border-border-default bg-surface-raised px-3.5 py-3 text-sm text-text-secondary">
                {entry.toolCalls.length > 0 && <ToolCalls calls={entry.toolCalls} />}
                <div className="markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{entry.content}</Markdown>
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
              </div>
              {entry.edits.map((edit) => (
                <EditCard
                  key={edit.path}
                  edit={edit}
                  onApprove={() => approve(i, edit)}
                  onReject={() => setEditStatus(i, edit.path, { state: "rejected" })}
                />
              ))}
            </div>
          ),
        )}
        {sending && <p className="text-[13px] text-text-muted">Thinking…</p>}
        {error && <p className="text-[13px] text-accent">Could not get an answer ({error}).</p>}
        <div ref={bottomRef} />
      </div>

      <div className="relative flex items-end gap-2 border-t border-border-default px-5 pb-[18px] pt-3">
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
            rows={multiline ? 3 : 1}
            placeholder="Ask, or type / for commands"
            className={`block min-h-11 w-full resize-none rounded-[10px] ${multiline ? "" : "overflow-hidden"} border border-border-light bg-surface-raised px-3 py-[11px] text-sm leading-5 placeholder:text-[#8797A1] focus:border-accent/70 focus:outline-none`}
            aria-autocomplete="list"
            aria-expanded={menuItems.length > 0}
          />
        </label>
        <button type="button" onClick={send} disabled={sending || !input.trim()} className="btn-primary min-h-11">
          Send
        </button>
      </div>
    </aside>
  );
}

const MODE_CHIP: Record<AccessMode, string> = {
  read_only: "Notes: read only",
  ask_first: "Notes: asks before writing",
  write_directly: "Notes: read and write",
};

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
      className="absolute inset-x-5 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border-strong bg-surface-active p-1.5 shadow-xl shadow-black/40"
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
            i === highlighted ? "bg-[#2A3842]" : ""
          }`}
        >
          <span className="flex w-full items-baseline gap-2">
            <span className="font-mono text-[13px] text-accent">{prompt.command}</span>
            <span className="truncate text-[13px] text-text-primary">{prompt.description}</span>
          </span>
          <span className="line-clamp-1 text-xs text-text-muted">{prompt.instruction}</span>
        </button>
      ))}
      <div className="mx-1.5 my-1 h-px bg-border-strong" />
      <Link
        to="/settings"
        onMouseDown={(e) => e.preventDefault()}
        className="block rounded-md px-3 py-1.5 text-xs text-text-muted hover:bg-[#2A3842] hover:text-text-primary"
      >
        Manage commands…
      </Link>
    </div>
  );
}

function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <details className="mb-2 text-xs text-text-muted">
      <summary className="cursor-pointer select-none">
        Used {calls.length} tool{calls.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {calls.map((call, i) => (
          <li key={i} className={call.ok ? "" : "text-accent"}>
            {call.name}({Object.values(call.arguments).map((v) => JSON.stringify(v)).join(", ")})
            {!call.ok && " — failed"}
          </li>
        ))}
      </ul>
    </details>
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
    <div className="flex flex-col gap-2 rounded-xl border border-border-light bg-surface-panel px-3.5 py-3 text-[13px] text-text-secondary">
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
