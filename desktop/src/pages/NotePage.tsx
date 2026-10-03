import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import { getJson, message } from "../lib/api";
import PageHeader from "../components/PageHeader";

// GET /api/notes/file (see NoteFile in backend/schemas.py).
type NoteFile = { path: string; frontmatter: Record<string, unknown>; content: string };
type State = { state: "loading" } | { state: "ok"; note: NoteFile } | { state: "error"; message: string };

function show(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A note, read-only; ask the Co-pilot to change it (`/note?path=...`). */
export default function NotePage() {
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const [note, setNote] = useState<State>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setNote({ state: "loading" });
    getJson<NoteFile>(`/api/notes/file?path=${encodeURIComponent(path)}`, controller.signal)
      .then((body) => setNote({ state: "ok", note: body }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setNote({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [path]);

  const parts = path.split("/");
  const fm = note.state === "ok" ? note.note.frontmatter : {};
  const title = typeof fm.title === "string" && fm.title ? fm.title : parts[parts.length - 1].replace(/\.md$/i, "");
  const props = Object.entries(fm).filter(([key, value]) => key !== "title" && value !== null && value !== "");

  return (
    <div className="flex max-w-4xl flex-col gap-5 px-9 py-7">
      <PageHeader eyebrow={parts.slice(0, -1).join(" / ").toUpperCase() || "NOTES"} title={title} />
      {note.state === "loading" && <p className="text-[13px] text-text-muted">Loading…</p>}
      {note.state === "error" && <p className="text-[13px] text-text-secondary">Could not open {path} ({note.message}).</p>}
      {note.state === "ok" && (
        <>
          {props.length > 0 && (
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-b border-border-default pb-4 text-[13px]">
              {props.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-text-muted">{key}</dt>
                  <dd className="text-text-secondary">{show(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          <article className="markdown text-sm leading-relaxed text-text-secondary">
            <Markdown remarkPlugins={[remarkGfm]}>{note.note.content}</Markdown>
          </article>
        </>
      )}
    </div>
  );
}
