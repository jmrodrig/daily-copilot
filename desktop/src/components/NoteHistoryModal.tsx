import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { getJson, message, sendJson } from "../lib/api";
import { NEUTRAL_TAG, Tag } from "./TriageBoard";

// GET /api/notes/history and GET /api/notes/history/{id} (see NoteVersionSummary / NoteVersionDetail in
// backend/schemas.py). Timestamps are naive UTC.
type NoteVersion = {
  id: number;
  timestamp: string;
  action: string;
  source: string;
  title: string | null;
  state: string | null;
  content_length: number;
};
type NoteVersionDetail = {
  id: number;
  timestamp: string;
  action: string;
  source: string;
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
};
export type RestoredNote = { path: string; frontmatter: Record<string, unknown>; content: string };

type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

const ACTION_LABELS: Record<string, string> = { create: "Created", update: "Edited", rename: "Renamed", delete: "Deleted" };
const ADDED = "bg-project-p5002/[0.12] text-project-p5002";
const REMOVED = "bg-accent/10 text-accent";

/** A history timestamp (naive UTC) as a Date. */
const parseTimestamp = (timestamp: string) => new Date(/Z|[+-]\d{2}:?\d{2}$/.test(timestamp) ? timestamp : `${timestamp}Z`);

/** "Today, 12:47 PM", "Yesterday, 3:56 PM", "Mon 12 Oct, 9:05 AM" or, from another year, "12 Oct 2025, 9:05 AM". */
function formatWhen(date: Date, now = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: days < 7 ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${day}, ${time}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "2 hours ago", "just now". */
function relativeTime(date: Date, now = new Date()): string {
  const seconds = (date.getTime() - now.getTime()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const actionLabel = (version: { action: string; source: string }) =>
  version.source === "restore" ? "Restored" : ACTION_LABELS[version.action] ?? version.action;

type DiffLine = { kind: "same" | "add" | "del"; text: string };

// Past this many cells (lines × lines, after trimming the common start and end) the line diff isn't worked out.
const MAX_DIFF_CELLS = 4_000_000;

/** A line-by-line diff (longest common subsequence) turning `before` into `after`. */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_DIFF_CELLS) {
    return [...head, ...midA.map((text): DiffLine => ({ kind: "del", text })), ...midB.map((text): DiffLine => ({ kind: "add", text })), ...tail];
  }
  // lengths[i][j]: the longest common subsequence of midA[i:] and midB[j:], in one flat array.
  const lengths = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * (m + 1) + j] =
        midA[i] === midB[j]
          ? lengths[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1]);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      middle.push({ kind: "same", text: midA[i] });
      i++;
      j++;
    } else if (lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1]) {
      middle.push({ kind: "del", text: midA[i++] });
    } else {
      middle.push({ kind: "add", text: midB[j++] });
    }
  }
  while (i < n) middle.push({ kind: "del", text: midA[i++] });
  while (j < m) middle.push({ kind: "add", text: midB[j++] });
  return [...head, ...middle, ...tail];
}

// Unchanged lines shown around each change; longer unchanged stretches are folded.
const CONTEXT = 3;

type DiffChunk = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; count: number };

/** The diff with long stretches of unchanged lines folded away. */
function foldDiff(lines: DiffLine[]): DiffChunk[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) keep[k] = true;
  });
  const chunks: DiffChunk[] = [];
  lines.forEach((line, index) => {
    const last = chunks[chunks.length - 1];
    if (keep[index]) {
      if (last?.kind === "lines") last.lines.push(line);
      else chunks.push({ kind: "lines", lines: [line] });
    } else if (last?.kind === "fold") last.count++;
    else chunks.push({ kind: "fold", count: 1 });
  });
  return chunks;
}

const titleOf = (frontmatter: Record<string, unknown>) => (typeof frontmatter.title === "string" ? frontmatter.title : "");

/**
 * The version history of a note (or template): its saved versions, newest first, on the left; the selected one on
 * the right, as the changes from it to the note as it is now or as the note it was. "Restore this version" writes it
 * back over the note (itself saved as a new version, so a restore can be undone the same way) and hands the restored
 * note to `onRestored`.
 */
export default function NoteHistoryModal({
  spaceId,
  path,
  isTemplate,
  title,
  current,
  renderPreview,
  onRestored,
  onClose,
}: {
  spaceId: number;
  path: string;
  isTemplate: boolean;
  title: string;
  /** The note as it is on disk now, to compare versions with. */
  current: { frontmatter: Record<string, unknown>; content: string };
  /** A version's body as the note page shows it. */
  renderPreview: (version: { frontmatter: Record<string, unknown>; content: string }) => ReactNode;
  onRestored: (note: RestoredNote) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<Load<NoteVersion[]>>({ state: "loading" });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, Load<NoteVersionDetail>>>({});
  const [view, setView] = useState<"diff" | "preview">("diff");
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const root = isTemplate ? "templates" : "content";

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ space_id: String(spaceId), path, root });
    getJson<NoteVersion[]>(`/api/notes/history?${query}`, controller.signal)
      .then((loaded) => {
        setVersions({ state: "ok", value: loaded });
        setSelectedId(loaded[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setVersions({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [spaceId, path, root]);

  // Each version's snapshot is fetched once, as it's first selected.
  const detail = selectedId === null ? undefined : details[selectedId];
  useEffect(() => {
    if (selectedId === null || details[selectedId]) return;
    const id = selectedId;
    setDetails((all) => ({ ...all, [id]: { state: "loading" } }));
    getJson<NoteVersionDetail>(`/api/notes/history/${id}`)
      .then((value) => setDetails((all) => ({ ...all, [id]: { state: "ok", value } })))
      .catch((err: unknown) => setDetails((all) => ({ ...all, [id]: { state: "error", message: message(err) } })));
  }, [selectedId, details]);

  useEffect(() => {
    setConfirming(false);
    setRestoreError(null);
  }, [selectedId]);

  // Escape closes (or first backs out of confirming a restore); in the timeline, arrows move through the versions.
  const list = versions.state === "ok" ? versions.value : [];
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (confirming) setConfirming(false);
        else if (!restoring) onClose();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && list.length > 0 && e.target instanceof Node && listRef.current?.contains(e.target)) {
        e.preventDefault();
        const index = list.findIndex((v) => v.id === selectedId);
        const next = e.key === "ArrowDown" ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1);
        setSelectedId(list[next].id);
        listRef.current.querySelector<HTMLElement>(`[data-version="${list[next].id}"] button`)?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [confirming, restoring, onClose, list, selectedId]);

  const selected = detail?.state === "ok" ? detail.value : null;
  const diff = useMemo(() => (selected ? foldDiff(diffLines(selected.content, current.content)) : []), [selected, current.content]);
  const unchanged = selected !== null && selected.content === current.content && titleOf(selected.frontmatter) === titleOf(current.frontmatter);

  async function restore() {
    if (!selected) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const query = new URLSearchParams({ space_id: String(spaceId), path, root });
      const note = await sendJson<RestoredNote>("POST", `/api/notes/history/${selected.id}/restore?${query}`);
      onRestored(note);
    } catch (err) {
      setRestoreError(message(err));
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 print:hidden" onMouseDown={() => !restoring && onClose()}>
      <div
        role="dialog"
        aria-modal
        aria-label={`Version history of ${title}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full w-[min(1080px,92vw)] animate-pane-in flex-col border-l border-border-default bg-surface-panel shadow-2xl shadow-black/40"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border-default px-5 py-3">
          <h2 className="min-w-0 truncate text-base font-semibold">
            Version history <span className="text-text-muted">·</span> <span className="text-text-secondary">{title}</span>
          </h2>
          <button
            type="button"
            aria-label="Close version history"
            title="Close (Esc)"
            onClick={onClose}
            disabled={restoring}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav aria-label="Saved versions" className="w-72 shrink-0 overflow-y-auto border-r border-border-default">
            {versions.state === "loading" && <p className="p-4 text-[14px] text-text-muted">Loading…</p>}
            {versions.state === "error" && <p className="p-4 text-[14px] text-accent">Could not load the history ({versions.message}).</p>}
            {versions.state === "ok" && list.length === 0 && (
              <p className="p-4 text-[14px] text-text-muted">No saved versions yet. Versions are kept each time the note is saved.</p>
            )}
            <ol ref={listRef} className="divide-y divide-border-default/60">
              {list.map((version, index) => {
                const when = parseTimestamp(version.timestamp);
                const older = list[index + 1];
                const delta = older ? version.content_length - older.content_length : null;
                const active = version.id === selectedId;
                return (
                  <li key={version.id} data-version={version.id}>
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => setSelectedId(version.id)}
                      className={`flex w-full flex-col gap-1 border-l-2 px-4 py-2.5 text-left transition-colors ${
                        active ? "border-accent bg-surface-active" : "border-transparent hover:bg-surface-hover"
                      }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-[14px] font-medium text-text-primary">{formatWhen(when)}</span>
                        {index === 0 && <span className="font-mono text-[11px] uppercase text-accent">Latest</span>}
                      </span>
                      <span className="text-xs text-text-muted" title={when.toLocaleString()}>
                        {relativeTime(when)}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Tag className={version.source === "restore" ? "border-accent/60 text-accent" : NEUTRAL_TAG}>{actionLabel(version)}</Tag>
                        <Tag className={NEUTRAL_TAG}>{version.source}</Tag>
                        <span className="font-mono text-[11px] text-text-muted">
                          {version.content_length.toLocaleString()} ch
                          {delta !== null && delta !== 0 && (
                            <span className={delta > 0 ? "text-project-p5002" : "text-accent"}>
                              {" "}
                              {delta > 0 ? "+" : "−"}
                              {Math.abs(delta).toLocaleString()}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section aria-label="Selected version" className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border-default px-5 py-2">
              <div role="tablist" aria-label="View" className="flex rounded-md border border-border-default p-0.5">
                {(
                  [
                    ["diff", "Changes"],
                    ["preview", "Preview"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={view === key}
                    onClick={() => setView(key)}
                    className={`rounded px-3 py-1 text-xs ${view === key ? "bg-surface-active text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {view === "diff" && selected && !unchanged && (
                <span className="font-mono text-[11px] text-text-muted">
                  <span className="text-accent">− this version</span> · <span className="text-project-p5002">+ current note</span>
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {detail?.state === "loading" && <p className="text-[14px] text-text-muted">Loading…</p>}
              {detail?.state === "error" && <p className="text-[14px] text-accent">Could not load this version ({detail.message}).</p>}
              {selected && view === "preview" && (
                <div className="flex flex-col gap-4">
                  <h1 className="text-[26px] font-semibold leading-tight">{titleOf(selected.frontmatter) || title}</h1>
                  {selected.path !== path && <p className="font-mono text-xs text-text-muted">Saved as {selected.path}</p>}
                  {renderPreview(selected)}
                </div>
              )}
              {selected && view === "diff" && (
                <DiffView diff={diff} unchanged={unchanged} titleBefore={titleOf(selected.frontmatter)} titleAfter={titleOf(current.frontmatter)} />
              )}
            </div>

            {selected && (
              <footer className="flex flex-col gap-2 border-t border-border-default px-5 py-3">
                {restoreError && <p className="text-[14px] text-accent">Could not restore this version ({restoreError}).</p>}
                <div className="flex items-center justify-between gap-4">
                  <p className="text-xs text-text-muted">
                    Restoring will replace the current note content with this version. A new snapshot of the current state will be
                    preserved.
                  </p>
                  {confirming ? (
                    <div className="flex shrink-0 gap-2">
                      <button type="button" className="btn min-h-9 px-3 text-xs" onClick={() => setConfirming(false)} disabled={restoring}>
                        Cancel
                      </button>
                      <button type="button" autoFocus className="btn-primary min-h-9 px-3 text-xs" onClick={() => void restore()} disabled={restoring}>
                        {restoring ? "Restoring…" : "Yes, restore"}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary min-h-9 shrink-0 px-3 text-xs"
                      onClick={() => setConfirming(true)}
                      disabled={unchanged}
                      title={unchanged ? "This version is the same as the current note" : undefined}
                    >
                      Restore this version
                    </button>
                  )}
                </div>
              </footer>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DiffView({ diff, unchanged, titleBefore, titleAfter }: { diff: DiffChunk[]; unchanged: boolean; titleBefore: string; titleAfter: string }) {
  if (unchanged) return <p className="text-[14px] text-text-muted">This version is the same as the current note.</p>;
  return (
    <div className="flex flex-col gap-3">
      {titleBefore !== titleAfter && (
        <p className="text-[14px] text-text-secondary">
          Title: <span className={`rounded px-1 line-through ${REMOVED}`}>{titleBefore || "(none)"}</span> →{" "}
          <span className={`rounded px-1 ${ADDED}`}>{titleAfter || "(none)"}</span>
        </p>
      )}
      <pre className="overflow-x-auto rounded-lg border border-border-default font-mono text-[13px] leading-5">
        {diff.map((chunk, index) =>
          chunk.kind === "fold" ? (
            <div key={index} className="select-none border-y border-border-default/60 bg-surface-raised px-3 py-0.5 text-[11px] text-text-muted">
              ⋯ {chunk.count} unchanged {chunk.count === 1 ? "line" : "lines"}
            </div>
          ) : (
            chunk.lines.map((line, k) => (
              <div
                key={`${index}:${k}`}
                className={`whitespace-pre-wrap break-words px-3 ${line.kind === "add" ? ADDED : line.kind === "del" ? REMOVED : "text-text-secondary"}`}
              >
                <span aria-hidden className="mr-3 inline-block w-3 select-none text-text-muted">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                {line.text || " "}
              </div>
            ))
          ),
        )}
      </pre>
    </div>
  );
}
