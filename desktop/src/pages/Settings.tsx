import { useEffect, useState, type FormEvent } from "react";

import { errorDetail, getJson, message, PROMPTS_CHANGED, type SavedPrompt } from "../lib/api";

type Draft = { command: string; description: string; instruction: string };
type State = { state: "loading" } | { state: "ok"; prompts: SavedPrompt[] } | { state: "error"; message: string };
/** Which form is open: a new command, or editing an existing one by id. */
type Editing = null | "new" | number;

const EMPTY: Draft = { command: "/", description: "", instruction: "" };

export default function Settings() {
  const [prompts, setPrompts] = useState<State>({ state: "loading" });
  const [editing, setEditing] = useState<Editing>(null);

  async function load(signal?: AbortSignal) {
    try {
      setPrompts({ state: "ok", prompts: await getJson<SavedPrompt[]>("/api/prompts", signal) });
    } catch (err: unknown) {
      if (!signal?.aborted) setPrompts({ state: "error", message: message(err) });
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  /** Reload the list here and in the chat's command menu. */
  async function changed() {
    setEditing(null);
    await load();
    window.dispatchEvent(new Event(PROMPTS_CHANGED));
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5 px-9 py-7">
      <header>
        <div className="font-mono text-xs tracking-[0.06em] text-text-muted">SETTINGS</div>
        <h1 className="mt-1 text-[28px] font-semibold">Saved prompts</h1>
        <div className="mt-1 text-[13px] text-text-muted">
          Slash commands for the Co-pilot chat. Type the command (e.g. <span className="font-mono">/prep</span>) at the
          start of a message and the Co-pilot follows its instruction; anything after the command is passed along too.
        </div>
      </header>

      <section className="panel flex flex-col gap-0 !px-0 !py-0" aria-label="Commands">
        <div className="flex items-center justify-between px-[22px] py-4">
          <h2 className="text-base font-semibold">Commands</h2>
          <button type="button" className="btn-primary" onClick={() => setEditing("new")} disabled={editing === "new"}>
            New command
          </button>
        </div>
        {editing === "new" && (
          <div className="border-t border-border-default px-[22px] py-4">
            <PromptForm initial={EMPTY} onCancel={() => setEditing(null)} onSaved={changed} />
          </div>
        )}
        {prompts.state === "loading" && (
          <p className="border-t border-border-default px-[22px] py-4 text-[13px] text-text-muted">Loading…</p>
        )}
        {prompts.state === "error" && (
          <p className="border-t border-border-default px-[22px] py-4 text-[13px] text-text-secondary">
            Could not load the saved prompts ({prompts.message}).
          </p>
        )}
        {prompts.state === "ok" && prompts.prompts.length === 0 && editing !== "new" && (
          <p className="border-t border-border-default px-[22px] py-4 text-[13px] text-text-muted">
            No commands yet. Create one, e.g. <span className="font-mono">/prep</span> to draft a meeting prep brief.
          </p>
        )}
        {prompts.state === "ok" &&
          prompts.prompts.map((prompt) => (
            <div key={prompt.id} className="border-t border-border-default px-[22px] py-4">
              {editing === prompt.id ? (
                <PromptForm initial={prompt} id={prompt.id} onCancel={() => setEditing(null)} onSaved={changed} />
              ) : (
                <PromptRow prompt={prompt} onEdit={() => setEditing(prompt.id)} onDeleted={changed} />
              )}
            </div>
          ))}
      </section>
    </div>
  );
}

function PromptRow({ prompt, onEdit, onDeleted }: { prompt: SavedPrompt; onEdit: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm(`Delete ${prompt.command}?`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/prompts/${prompt.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorDetail(res));
      onDeleted();
    } catch (err: unknown) {
      setError(message(err));
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm text-accent">{prompt.command}</span>
          {prompt.description && <span className="text-sm font-medium">{prompt.description}</span>}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-text-secondary">{prompt.instruction}</p>
        {error && <p className="mt-1.5 text-xs text-accent">Could not delete ({error}).</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" className="btn !min-h-8 !text-xs" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn !min-h-8 !text-xs" onClick={remove} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function PromptForm({
  initial,
  id,
  onCancel,
  onSaved,
}: {
  initial: Draft;
  id?: number;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    command: initial.command,
    description: initial.description,
    instruction: initial.instruction,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\/?[a-z0-9][a-z0-9_-]*$/i.test(draft.command.trim()) && draft.instruction.trim() !== "";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(id === undefined ? "/api/prompts" : `/api/prompts/${id}`, {
        method: id === undefined ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      onSaved();
    } catch (err: unknown) {
      setError(message(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-text-muted">COMMAND</span>
          <input
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            className="field font-mono"
            placeholder="/prep"
            maxLength={32}
            required
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-text-muted">DESCRIPTION</span>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            className="field"
            placeholder="Draft a meeting prep brief"
            maxLength={200}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-text-muted">INSTRUCTION</span>
        <textarea
          value={draft.instruction}
          onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
          className="field min-h-32 resize-y leading-normal"
          placeholder="Read the open items from the last meeting and the project's overdue tasks, then draft a meeting prep brief…"
          required
        />
      </label>
      {error && <p className="text-xs text-accent">Could not save ({error}).</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={!valid || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
