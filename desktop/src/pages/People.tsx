import { useEffect, useState, type FormEvent } from "react";

import PageHeader from "../components/PageHeader";
import { getJson, message, sendJson } from "../lib/api";
import { useSpace } from "../lib/space";

// Shape of GET /api/people (see Person in backend/schemas.py).
type Person = {
  id: number;
  space_id: number;
  name: string;
  email: string | null;
  company: string | null;
  is_external: boolean;
  avatar_url: string | null;
};

type PersonDraft = Pick<Person, "name" | "is_external"> & { email: string; company: string; avatar_url: string };

const EMPTY_DRAFT: PersonDraft = { name: "", email: "", company: "", is_external: false, avatar_url: "" };

type State = { state: "loading" } | { state: "ok"; people: Person[] } | { state: "error"; message: string };
type Show = "all" | "internal" | "external";

/** Up to two initials: the first letters of the first and last words of the name. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function byName(a: Person, b: Person) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
}

/** The space's People directory: colleagues and external contacts (clients, suppliers). */
export default function People() {
  const { spaceId, space } = useSpace();
  const [people, setPeople] = useState<State>({ state: "loading" });
  const [show, setShow] = useState<Show>("all");
  const [editing, setEditing] = useState<Person | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPeople({ state: "loading" });
    setEditing(null);
    getJson<Person[]>(`/api/people?space_id=${spaceId}`, controller.signal)
      .then((body) => setPeople({ state: "ok", people: body }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setPeople({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [spaceId]);

  /** Put a created or edited person in the list, keeping it sorted by name. */
  function store(person: Person) {
    setPeople((prev) =>
      prev.state === "ok" ? { state: "ok", people: [...prev.people.filter((p) => p.id !== person.id), person].sort(byName) } : prev,
    );
  }

  async function remove(person: Person) {
    if (!window.confirm(`Remove ${person.name} from People? They stay in the version history.`)) return;
    setError(null);
    try {
      await sendJson("DELETE", `/api/people/${person.id}`);
      setPeople((prev) => (prev.state === "ok" ? { state: "ok", people: prev.people.filter((p) => p.id !== person.id) } : prev));
      if (editing?.id === person.id) setEditing(null);
    } catch (err: unknown) {
      setError(`Could not remove ${person.name}: ${message(err)}`);
    }
  }

  const all = people.state === "ok" ? people.people : [];
  const counts = { all: all.length, internal: all.filter((p) => !p.is_external).length, external: all.filter((p) => p.is_external).length };
  const shown = all.filter((p) => show === "all" || (show === "external") === p.is_external);

  return (
    <div className="flex flex-col gap-5 px-9 py-7">
      <PageHeader
        eyebrow={`${(space?.name ?? "").toUpperCase()} · PEOPLE`}
        title="People"
        subtitle="Colleagues and external contacts (clients, suppliers) of this space."
      />

      <PersonForm key={`new-${spaceId}`} spaceId={spaceId} onSaved={store} />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show">
        {(["all", "internal", "external"] as Show[]).map((key) => (
          <button key={key} type="button" className={show === key ? "seg-on" : "seg"} aria-pressed={show === key} onClick={() => setShow(key)}>
            {key === "all" ? "Everyone" : key === "internal" ? "Internal" : "External"} ({counts[key]})
          </button>
        ))}
      </div>

      {error && <p className="text-[15px] text-accent">{error}</p>}
      {people.state === "loading" && <p className="text-[15px] text-text-muted">Loading people…</p>}
      {people.state === "error" && <p className="text-[15px] text-text-secondary">Could not load people ({people.message}).</p>}
      {people.state === "ok" &&
        (shown.length === 0 ? (
          <p className="panel text-center text-sm text-text-muted">
            {all.length === 0 ? "No people yet. Add someone above." : "Nobody matches this filter."}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {shown.map((person) =>
              editing?.id === person.id ? (
                <li key={person.id} className="col-span-full">
                  <PersonForm
                    spaceId={spaceId}
                    person={person}
                    onSaved={(saved) => {
                      store(saved);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <PersonCard key={person.id} person={person} onEdit={() => setEditing(person)} onRemove={() => remove(person)} />
              ),
            )}
          </ul>
        ))}
    </div>
  );
}

function Avatar({ person }: { person: Pick<Person, "name" | "avatar_url" | "is_external"> }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person.avatar_url]);
  const size = "h-11 w-11 shrink-0 rounded-full";
  if (person.avatar_url && !broken) {
    return <img src={person.avatar_url} alt="" onError={() => setBroken(true)} className={`${size} border border-border-default object-cover`} />;
  }
  return (
    <span
      aria-hidden
      className={`${size} flex items-center justify-center border font-mono text-[15px] font-semibold ${
        person.is_external ? "border-accent/50 bg-accent/[0.12] text-accent-soft" : "border-border-strong bg-surface-panel text-text-secondary"
      }`}
    >
      {initials(person.name)}
    </span>
  );
}

function PersonCard({ person, onEdit, onRemove }: { person: Person; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="group flex gap-3 rounded-lg border border-border-default bg-surface-raised p-3">
      <Avatar person={person} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-text-primary">{person.name}</span>
          <span
            className={`shrink-0 rounded border px-1.5 py-px font-mono text-[12px] uppercase leading-4 ${
              person.is_external ? "border-accent/60 text-accent" : "border-project-neutral/60 text-text-muted"
            }`}
          >
            {person.is_external ? "External" : "Internal"}
          </span>
        </div>
        {person.company && <span className="truncate text-[13px] text-text-secondary">{person.company}</span>}
        {person.email ? (
          <a href={`mailto:${person.email}`} className="truncate text-[13px] text-text-muted hover:text-accent hover:underline">
            {person.email}
          </a>
        ) : (
          <span className="text-[13px] text-text-muted">No email</span>
        )}
        <span className="mt-1 flex gap-3 text-xs text-text-muted opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button type="button" className="hover:text-text-primary" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="hover:text-accent" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
    </li>
  );
}

/** Add a person, or (with `person`) edit one. */
function PersonForm({
  spaceId,
  person,
  onSaved,
  onCancel,
}: {
  spaceId: number;
  person?: Person;
  onSaved: (person: Person) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<PersonDraft>(
    person
      ? { name: person.name, email: person.email ?? "", company: person.company ?? "", is_external: person.is_external, avatar_url: person.avatar_url ?? "" }
      : EMPTY_DRAFT,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<PersonDraft>) => setDraft((prev) => ({ ...prev, ...change }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return;
    setSaving(true);
    setError(null);
    const body = {
      space_id: spaceId,
      name: draft.name.trim(),
      email: draft.email.trim() || null,
      company: draft.company.trim() || null,
      is_external: draft.is_external,
      avatar_url: draft.avatar_url.trim() || null,
    };
    try {
      const saved = person
        ? await sendJson<Person>("PUT", `/api/people/${person.id}`, body)
        : await sendJson<Person>("POST", "/api/people", body);
      onSaved(saved);
      if (!person) setDraft(EMPTY_DRAFT);
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  const label = "flex flex-col gap-1 text-[13px] text-text-muted";
  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && onCancel?.()}
      aria-label={person ? `Edit ${person.name}` : "Add a person"}
      className="flex flex-wrap items-end gap-2 rounded-lg border border-border-default bg-surface-raised p-3"
    >
      <Avatar person={{ name: draft.name || "?", avatar_url: draft.avatar_url.trim() || null, is_external: draft.is_external }} />
      <label className={`${label} min-w-[180px] flex-1`}>
        {person ? "Name" : "New person"}
        <input
          autoFocus={!!person}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Full name"
          maxLength={128}
          className="field py-1.5"
        />
      </label>
      <label className={label}>
        Email
        <input type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} placeholder="name@example.com" className="field w-52 py-1.5" />
      </label>
      <label className={label}>
        Company
        <input value={draft.company} onChange={(e) => set({ company: e.target.value })} placeholder="Optional" maxLength={128} className="field w-40 py-1.5" />
      </label>
      <label className={label}>
        Avatar URL
        <input value={draft.avatar_url} onChange={(e) => set({ avatar_url: e.target.value })} placeholder="https://… (optional)" className="field w-48 py-1.5" />
      </label>
      <label className="flex min-h-9 items-center gap-2 text-[13px] text-text-muted">
        <input type="checkbox" checked={draft.is_external} onChange={(e) => set({ is_external: e.target.checked })} />
        External
      </label>
      <div className="flex gap-2">
        {onCancel && (
          <button type="button" className="btn min-h-9" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary min-h-9" disabled={saving || !draft.name.trim()}>
          {saving ? "Saving…" : person ? "Save" : "Add person"}
        </button>
      </div>
      {error && <p className="w-full text-xs text-accent">{error}</p>}
    </form>
  );
}
