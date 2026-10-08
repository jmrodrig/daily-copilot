import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import Popover from "../components/Popover";
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

/** One choice of an `AssigneeSelect`: a person, nobody (`name` null), or a typed name not in People. */
type AssigneeChoice = { key: string; name: string | null; person?: Person; note?: string };

/**
 * Picks a task's assignee: type to filter the space's People ("Me" first), or to assign a name that isn't in People.
 * Arrow keys move through the list and Enter picks; leaving the field keeps what was typed (cleared means
 * unassigned), Escape drops it. `onChange` gets the assignee's raw name, and only when it changes. An assignee who
 * isn't in People (typed before the directory existed) stays listed, so showing it doesn't change it.
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
  const [open, setOpen] = useState(false);
  // What's typed since the field was focused; null shows the current assignee.
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const listId = useId();

  const ordered = useMemo(() => [...people].sort((a, b) => Number(b.is_me) - Number(a.is_me) || byName(a, b)), [people]);
  const activePerson = people.find((p) => p.name === value);
  const typed = (query ?? "").trim().slice(0, ASSIGNEE_MAX);
  const needle = typed.toLowerCase();
  const known = needle ? people.find((p) => p.name.toLowerCase() === needle || personLabel(p).toLowerCase() === needle) : undefined;

  const choices: AssigneeChoice[] = needle
    ? [
        ...ordered.filter((p) => personLabel(p).toLowerCase().includes(needle)).map((p) => ({ key: `p${p.id}`, name: p.name, person: p })),
        ...(known ? [] : [{ key: "new", name: typed, note: "not in People" }]),
      ]
    : [
        { key: "none", name: null },
        ...ordered.map((p) => ({ key: `p${p.id}`, name: p.name, person: p })),
        ...(value && !activePerson ? [{ key: "unknown", name: value, note: "not in People" }] : []),
      ];

  function show() {
    if (disabled) return;
    setHighlight(Math.max(0, choices.findIndex((c) => c.name === value)));
    setOpen(true);
  }

  function pick(name: string | null) {
    setQuery(null);
    setOpen(false);
    if (name !== value) onChange(name);
  }

  /** Keeps what was typed: a person by name (in any case), a new name, or nobody if cleared. */
  function commitTyped() {
    if (query === null) setOpen(false);
    else pick(typed ? (known?.name ?? typed) : null);
  }

  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + choices.length) % choices.length);
    } else if (e.key === "Enter" && open) {
      // Picks rather than submitting the form around it; the next Enter does that.
      e.preventDefault();
      e.stopPropagation();
      const choice = choices[highlight];
      if (choice) pick(choice.name);
      else commitTyped();
    } else if (e.key === "Escape" && (open || query !== null)) {
      e.stopPropagation();
      setQuery(null);
      setOpen(false);
    }
  }

  const text = query ?? (activePerson ? personLabel(activePerson) : (value ?? ""));
  const showAvatar = activePerson && query === null;

  return (
    <div ref={anchor} className={`relative flex items-center ${className.includes("w-full") ? "w-full" : ""} ${className.includes("flex-1") ? "flex-1" : ""}`}>
      {showAvatar && (
        <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
          <Avatar person={activePerson} size="h-5 w-5 shrink-0 rounded-full" textClass="text-[9px]" />
        </div>
      )}
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && choices[highlight] ? `${listId}-${choices[highlight].key}` : undefined}
        value={text}
        placeholder={emptyLabel}
        disabled={disabled}
        maxLength={ASSIGNEE_MAX}
        autoComplete="off"
        title={value && !activePerson ? `${value} (not in People)` : undefined}
        onFocus={(e) => {
          e.target.select();
          show();
        }}
        onClick={() => !open && show()}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={commitTyped}
        onKeyDown={keys}
        className={`${className} w-full ${value || query ? "text-text-primary" : "text-text-muted"} ${showAvatar ? "pl-8" : ""}`}
      />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} id={listId} label={ariaLabel}>
        {choices.map((choice, index) => (
          <div
            key={choice.key}
            id={`${listId}-${choice.key}`}
            role="option"
            aria-selected={choice.name === value}
            // Keep the focus in the input, so picking doesn't first commit what was typed.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => pick(choice.name)}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${index === highlight ? "bg-surface-raised text-text-primary" : "text-text-secondary"}`}
          >
            {choice.person ? (
              <span className={choice.person.is_me ? "font-semibold" : undefined}>
                <PersonBadge person={choice.person} />
              </span>
            ) : choice.key === "new" ? (
              <span className="truncate">
                Assign “{choice.name}” <span className="text-text-muted">({choice.note})</span>
              </span>
            ) : choice.name === null ? (
              <span className="text-text-muted">{emptyLabel}</span>
            ) : (
              <span className="truncate">
                {choice.name} <span className="text-text-muted">({choice.note})</span>
              </span>
            )}
          </div>
        ))}
      </Popover>
    </div>
  );
}
