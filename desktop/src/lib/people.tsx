import { useEffect, useState } from "react";

import { getJson } from "./api";

// Shape of GET /api/people (see Person in backend/schemas.py).
export type Person = {
  id: number;
  space_id: number;
  name: string;
  email: string | null;
  company: string | null;
  is_external: boolean;
  avatar_url: string | null;
  /** The app's user: at most one person per space. */
  is_me: boolean;
};

/** The longest name a task's assignee can hold (`TaskUpdate.assignee`), so People names are capped to it too. */
export const ASSIGNEE_MAX = 64;

/** Up to two initials: the first letters of the first and last words of the name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function byName(a: Person, b: Person) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
}

/** Fired after the People directory changes, so assignee pickers elsewhere reload it. */
export const PEOPLE_CHANGED = "copilot:people-changed";

export function announcePeopleChange() {
  window.dispatchEvent(new Event(PEOPLE_CHANGED));
}

/** The People directory of a space, by name; empty while loading or if it can't be loaded. */
export function usePeople(spaceId: number): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const reload = () => setVersion((v) => v + 1);
    window.addEventListener(PEOPLE_CHANGED, reload);
    return () => window.removeEventListener(PEOPLE_CHANGED, reload);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getJson<Person[]>(`/api/people?space_id=${spaceId}`, controller.signal)
      .then(setPeople)
      .catch(() => {
        if (!controller.signal.aborted) setPeople([]);
      });
    return () => controller.abort();
  }, [spaceId, version]);

  return people;
}

/** A person's name as offered in an assignee picker: "Jose Rodrigues (Me)" for the app's user. */
export function personLabel(person: Pick<Person, "name" | "is_me">): string {
  return person.is_me ? `${person.name} (Me)` : person.name;
}

export function Avatar({ person, size = "h-11 w-11 shrink-0 rounded-full", textClass = "text-[15px]" }: { person: Pick<Person, "name" | "avatar_url" | "is_external">; size?: string; textClass?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person.avatar_url]);
  
  if (person.avatar_url && !broken) {
    return <img src={person.avatar_url} alt="" onError={() => setBroken(true)} className={`${size} border border-border-default object-cover`} />;
  }
  return (
    <span
      aria-hidden
      className={`${size} flex items-center justify-center border font-mono ${textClass} font-semibold ${
        person.is_external ? "border-accent/50 bg-accent/[0.12] text-accent-soft" : "border-border-strong bg-surface-panel text-text-secondary"
      }`}
    >
      {initials(person.name)}
    </span>
  );
}

export function PersonBadge({ person }: { person: Pick<Person, "name" | "avatar_url" | "is_external" | "is_me"> }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar person={person} size="h-5 w-5 shrink-0 rounded-full" textClass="text-[9px]" />
      <span className="truncate">{personLabel(person)}</span>
    </div>
  );
}

/**
 * Picks a task's assignee from the space's People ("Me" first). An assignee who isn't in People (typed before the
 * directory existed) stays selectable, so showing it doesn't change it.
 */
export function AssigneeSelect({
  value,
  people,
  onChange,
  ariaLabel = "Assignee",
  emptyLabel = "Unassigned",
  className,
  disabled,
}: {
  value: string | null;
  people: Person[];
  onChange: (assignee: string | null) => void;
  ariaLabel?: string;
  emptyLabel?: string;
  className: string;
  disabled?: boolean;
}) {
  const ordered = [...people].sort((a, b) => Number(b.is_me) - Number(a.is_me) || byName(a, b));
  const activePerson = people.find((p) => p.name === value);
  const unknown = value && !activePerson ? value : null;
  
  return (
    <div className={`relative flex items-center ${className.includes("w-full") ? "w-full" : ""} ${className.includes("flex-1") ? "flex-1" : ""}`}>
      {activePerson && (
        <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
          <Avatar person={activePerson} size="h-5 w-5 shrink-0 rounded-full" textClass="text-[9px]" />
        </div>
      )}
      <select
        aria-label={ariaLabel}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className={`${className} w-full ${value ? "text-text-primary" : "text-text-muted"} ${activePerson ? "pl-8" : ""}`}
      >
        <option value="">{emptyLabel}</option>
        {ordered.map((person) => (
          <option key={person.id} value={person.name} className={person.is_me ? "font-semibold" : undefined}>
            {personLabel(person)}
          </option>
        ))}
        {unknown && <option value={unknown}>{unknown} (not in People)</option>}
      </select>
    </div>
  );
}
