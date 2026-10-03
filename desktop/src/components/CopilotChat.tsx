import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
type Entry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; edits: Edit[]; written: string[]; toolCalls: ToolCall[] };

const MODES: { value: AccessMode; label: string }[] = [
  { value: "read_only", label: "Read only" },
  { value: "ask_first", label: "Ask first" },
  { value: "write_directly", label: "Write directly" },
];
const MODE_KEY = "copilot.accessMode";
const CONTEXT_LINES = 3;

function storedMode(): AccessMode {
  const value = localStorage.getItem(MODE_KEY);
  return MODES.some((m) => m.value === value) ? (value as AccessMode) : "ask_first";
}

async function errorDetail(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`;
}

/** What the model sees of an assistant turn: its reply plus what the user did with its proposed edits. */
function historyContent(entry: Entry): string {
  if (entry.role === "user") return entry.content;
  const outcomes = entry.edits
    .filter((e) => e.status.state === "applied" || e.status.state === "rejected")
    .map((e) => `[The user ${e.status.state === "applied" ? "approved and saved" : "rejected"} the edit to ${e.path}]`);
  return [entry.content, ...outcomes].join("\n\n");
}

export default function CopilotChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AccessMode>(storedMode);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [entries, sending]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const next: Entry[] = [...entries, { role: "user", content: text }];
    setEntries(next);
    setInput("");
    setError(null);
    setSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map((entry) => ({ role: entry.role, content: historyContent(entry) })),
          access_mode: mode,
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
      setError(err instanceof Error ? err.message : String(err));
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
          path: edit.path,
          content: edit.content,
          frontmatter: edit.frontmatter,
          base_hash: edit.base_hash,
        }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      setEditStatus(entryIndex, edit.path, { state: "applied" });
    } catch (err: unknown) {
      setEditStatus(entryIndex, edit.path, { state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <aside
      className={`w-[30rem] shrink-0 flex-col border-l border-border-default bg-surface-panel ${open ? "flex" : "hidden"}`}
      aria-label="Co-pilot chat"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border-default px-4">
        <span className="flex-1 text-sm font-semibold tracking-wide">Co-pilot</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as AccessMode)}
          className="rounded border border-border-light bg-surface-raised px-2 py-1 text-xs"
          aria-label="Access mode"
          title="What the Co-pilot may do with your notes"
        >
          {MODES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setEntries([]);
            setError(null);
          }}
          disabled={sending || entries.length === 0}
          className="rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-raised hover:text-text-primary disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised hover:text-text-primary"
          aria-label="Close chat"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {entries.length === 0 && (
          <p className="text-sm text-text-muted">
            Ask about your projects and notes, e.g. “What is currently overdue on C7801?” or “What did we decide about
            the keel design?”
          </p>
        )}
        {entries.map((entry, i) =>
          entry.role === "user" ? (
            <div key={i} className="ml-8 whitespace-pre-wrap rounded-lg bg-surface-raised px-3 py-2 text-sm">
              {entry.content}
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {entry.toolCalls.length > 0 && <ToolCalls calls={entry.toolCalls} />}
              <div className="markdown text-sm">
                <Markdown remarkPlugins={[remarkGfm]}>{entry.content}</Markdown>
              </div>
              {entry.written.map((path) => (
                <p key={path} className="font-mono text-xs text-project-p5002">
                  ✓ Wrote {path}
                </p>
              ))}
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
        {sending && <p className="text-sm text-text-muted">Thinking…</p>}
        {error && <p className="text-sm text-accent">Could not get an answer ({error}).</p>}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border-default p-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="Ask the Co-pilot… (Enter to send, Shift+Enter for a new line)"
          className="w-full resize-none rounded border border-border-light bg-surface-raised px-3 py-2 text-sm placeholder:text-text-muted"
          aria-label="Message"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={send}
            disabled={sending || !input.trim()}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-background hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}

function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <details className="text-xs text-text-muted">
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

function EditCard({ edit, onApprove, onReject }: { edit: Edit; onApprove: () => void; onReject: () => void }) {
  const { state } = edit.status;
  const isNew = edit.previous_content === null;
  const before = isNew ? "" : noteText(edit.previous_content ?? "", edit.previous_frontmatter ?? {});
  const after = noteText(edit.content, edit.frontmatter);

  return (
    <div className="overflow-hidden rounded-lg border border-accent/60 bg-surface-raised">
      <div className="flex items-center gap-2 border-b border-border-default px-3 py-2 text-xs">
        <span className="font-medium uppercase tracking-wider text-accent">{isNew ? "New note" : "Edit"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-secondary" title={edit.path}>
          {edit.path}
        </span>
      </div>
      <Diff before={before} after={after} />
      <div className="flex items-center justify-end gap-2 border-t border-border-default px-3 py-2 text-xs">
        {state === "applied" && <span className="text-project-p5002">✓ Saved</span>}
        {state === "rejected" && <span className="text-text-muted">Rejected</span>}
        {state === "error" && edit.status.state === "error" && (
          <span className="min-w-0 flex-1 text-accent">Could not save ({edit.status.message})</span>
        )}
        {(state === "pending" || state === "applying" || state === "error") && (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={state === "applying"}
              className="rounded border border-border-light px-3 py-1 text-text-secondary hover:bg-surface-panel hover:text-text-primary disabled:opacity-40"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={state === "applying"}
              className="rounded bg-accent px-3 py-1 font-semibold text-background hover:bg-accent/90 disabled:opacity-40"
            >
              {state === "applying" ? "Saving…" : "Approve"}
            </button>
          </>
        )}
      </div>
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
