import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

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
  /** "#rrggbb" for their avatar medallion; null uses the default. */
  color?: string | null;
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

type AvatarPerson = Pick<Person, "name" | "avatar_url" | "is_external" | "color">;

/** The medallion colours for a person's chosen colour: a tinted fill and border, and the colour itself for the initials. */
function medallionStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 60%, transparent)`,
    color,
  };
}

export function Avatar({ person, size = "h-11 w-11 shrink-0 rounded-full", textClass = "text-[15px]" }: { person: AvatarPerson; size?: string; textClass?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person.avatar_url]);
  
  if (person.avatar_url && !broken) {
    return <img src={person.avatar_url} alt="" onError={() => setBroken(true)} className={`${size} border border-border-default object-cover`} />;
  }
  const custom = medallionStyle(person.color);
  return (
    <span
      aria-hidden
      style={custom}
      className={`${size} flex items-center justify-center border font-mono ${textClass} font-semibold ${
        custom ? "" : person.is_external ? "border-accent/50 bg-accent/[0.12] text-accent-soft" : "border-border-strong bg-surface-panel text-text-secondary"
      }`}
    >
      {initials(person.name)}
    </span>
  );
}

export function PersonBadge({ person }: { person: AvatarPerson & Pick<Person, "is_me"> }) {
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

const UNKNOWN_PERSON = { avatar_url: null, is_external: false, color: null };

/** A person's medallion by name: their own when they're in People, else plain initials. */
function NamedAvatar({ name, people }: { name: string; people: Person[] }) {
  const person = people.find((p) => p.name === name) ?? { ...UNKNOWN_PERSON, name };
  return <Avatar person={person} size="h-5 w-5 shrink-0 rounded-full" textClass="text-[9px]" />;
}

/** "Jose (Me)", a person's name, or a name that isn't in People as it is. */
function nameLabel(name: string, people: Person[], me?: string): string {
  const person = people.find((p) => p.name === name);
  return personLabel({ name, is_me: person ? person.is_me : name === me });
}

/**
 * A task's assignees as overlapping avatars (each naming its person on hover), at most `max` of them and a "+n" for
 * the rest. `withName` adds everyone's names beside them.
 */
export function AvatarCluster({
  names,
  people,
  me,
  max = 4,
  withName = false,
}: {
  names: string[];
  people: Person[];
  me?: string;
  max?: number;
  withName?: boolean;
}) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const hidden = names.length - shown.length;
  const all = names.map((name) => nameLabel(name, people, me)).join(", ");
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={all}>
      <span className="flex shrink-0 items-center">
        {shown.map((name, i) => (
          <span key={name} title={nameLabel(name, people, me)} className={`rounded-full ring-2 ring-surface-raised ${i > 0 ? "-ml-1.5" : ""}`}>
            <NamedAvatar name={name} people={people} />
          </span>
        ))}
      </span>
      {hidden > 0 && <span className="shrink-0 font-mono text-[11px] text-text-muted">+{hidden}</span>}
      {withName && <span className="truncate">{all}</span>}
      <span className="sr-only">{withName ? "" : all}</span>
    </span>
  );
}

/** One choice of an `AssigneesSelect`: a person, a name that isn't in People, or a typed name to add (`isNew`). */
type AssigneesChoice = { key: string; name: string; person?: Person; isNew?: boolean };

/**
 * Picks a task's assignees. The chosen ones show as avatar chips (× removes one; Backspace in the empty field removes
 * the last). Typing filters the space's People ("Me" first) in a dropdown where a click or Enter ticks or unticks
 * someone, and a typed name that isn't in People can be added too. `compact` shows the chips as avatars only, for
 * table cells. `onChange` gets the new list of names, in the order they were picked.
 */
export function AssigneesSelect({
  value,
  people,
  onChange,
  ariaLabel = "Assignees",
  emptyLabel = "Unassigned",
  compact = false,
  className = "",
  disabled,
}: {
  value: string[];
  people: Person[];
  onChange: (assignees: string[]) => void;
  ariaLabel?: string;
  emptyLabel?: string;
  compact?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const ordered = useMemo(() => [...people].sort((a, b) => Number(b.is_me) - Number(a.is_me) || byName(a, b)), [people]);
  const typed = query.trim().slice(0, ASSIGNEE_MAX);
  const needle = typed.toLowerCase();
  const known = needle ? people.find((p) => p.name.toLowerCase() === needle || personLabel(p).toLowerCase() === needle) : undefined;
  const chosen = new Set(value);

  const choices: AssigneesChoice[] = [
    ...ordered.filter((p) => !needle || personLabel(p).toLowerCase().includes(needle)).map((p) => ({ key: `p${p.id}`, name: p.name, person: p })),
    // Assignees who aren't in People (typed before the directory existed) stay listed, so they can be unticked.
    ...value
      .filter((name) => !people.some((p) => p.name === name) && (!needle || name.toLowerCase().includes(needle)))
      .map((name) => ({ key: `n:${name}`, name })),
    ...(typed && !known && !value.some((name) => name.toLowerCase() === needle) ? [{ key: "new", name: typed, isNew: true }] : []),
  ];

  function show() {
    if (disabled) return;
    setHighlight(0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function toggle(name: string) {
    onChange(chosen.has(name) ? value.filter((n) => n !== name) : [...value, name]);
    setQuery("");
    setHighlight(0);
    input.current?.focus();
  }

  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      if (choices.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + choices.length) % choices.length);
    } else if (e.key === "Enter") {
      // Ticks rather than submitting the form around it.
      e.preventDefault();
      e.stopPropagation();
      const choice = open ? choices[highlight] : undefined;
      if (choice) toggle(choice.name);
      else if (!open) show();
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape" && (open || query)) {
      e.stopPropagation();
      close();
    }
  }

  return (
    <div
      ref={anchor}
      onClick={() => {
        input.current?.focus();
        if (!open) show();
      }}
      className={`flex min-w-0 cursor-text flex-wrap items-center gap-1 ${disabled ? "opacity-60" : ""} ${className}`}
    >
      {value.map((name) => {
        const person = people.find((p) => p.name === name);
        const label = person ? personLabel(person) : `${name} (not in People)`;
        if (compact) {
          return (
            <span key={name} title={label} className="shrink-0 rounded-full">
              <NamedAvatar name={name} people={people} />
            </span>
          );
        }
        return (
          <span
            key={name}
            title={label}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-default bg-surface-panel py-px pl-px pr-1.5 text-[13px] text-text-primary"
          >
            <NamedAvatar name={name} people={people} />
            <span className="truncate">{person ? personLabel(person) : name}</span>
            <button
              type="button"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              disabled={disabled}
              // Keep the focus where it is, so removing doesn't open the list.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((n) => n !== name));
              }}
              className="leading-none text-text-muted hover:text-accent"
            >
              ×
            </button>
          </span>
        );
      })}
      <input
        ref={input}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && choices[highlight] ? `${listId}-${choices[highlight].key}` : undefined}
        value={query}
        placeholder={value.length === 0 ? emptyLabel : compact ? "" : "Add…"}
        disabled={disabled}
        maxLength={ASSIGNEE_MAX}
        autoComplete="off"
        onFocus={show}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={close}
        onKeyDown={keys}
        className={`min-w-0 flex-1 bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none ${compact && value.length > 0 ? "w-3" : "w-16"}`}
      />
      <Popover anchor={anchor} open={open} onClose={close} id={listId} label={ariaLabel}>
        {choices.length === 0 && <div className="px-2 py-1.5 text-text-muted">No one in People yet: type a name</div>}
        {choices.map((choice, index) => {
          const ticked = chosen.has(choice.name);
          return (
            <div
              key={choice.key}
              id={`${listId}-${choice.key}`}
              role="option"
              aria-selected={ticked}
              // Keep the focus in the input, so the list stays open for the next pick.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => toggle(choice.name)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${index === highlight ? "bg-surface-raised text-text-primary" : "text-text-secondary"}`}
            >
              {choice.isNew ? (
                <span aria-hidden className="w-3.5 shrink-0 text-center font-mono text-text-muted">
                  +
                </span>
              ) : (
                <span
                  aria-hidden
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none ${
                    ticked ? "border-accent bg-accent text-white" : "border-border-strong"
                  }`}
                >
                  {ticked ? "✓" : ""}
                </span>
              )}
              {choice.person ? (
                <span className={choice.person.is_me ? "font-semibold" : undefined}>
                  <PersonBadge person={choice.person} />
                </span>
              ) : (
                <span className="truncate">
                  {choice.isNew ? `Assign “${choice.name}”` : choice.name} <span className="text-text-muted">(not in People)</span>
                </span>
              )}
            </div>
          );
        })}
      </Popover>
    </div>
  );
}
