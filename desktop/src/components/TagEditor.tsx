import { useEffect, useId, useState } from "react";

import { getJson } from "../lib/api";
import { useSpace } from "../lib/space";
import { LABEL_TAG } from "./TriageBoard";

/** A tag as typed: without leading `#`s and surrounding spaces. */
export function cleanTag(text: string): string {
  return text.trim().replace(/^#+/, "").trim();
}

/** `tags` with `tag` added, unless it (in any case) is already there. */
export function withTag(tags: string[], tag: string): string[] {
  const clean = cleanTag(tag);
  if (!clean || tags.some((t) => t.toLowerCase() === clean.toLowerCase())) return tags;
  return [...tags, clean];
}

/**
 * Tags as `#tag` pills (project codes in their project's color): hovering a pill shows an × that removes it, and
 * "+ Add tag" opens an inline input (Enter adds, Escape closes). While typing, a dropdown suggests the space's
 * existing tags (arrows move through it, Enter picks the highlighted one). Each change is saved through `onChange`.
 * Used for a note's tags and a task's.
 */
export default function TagEditor({
  spaceId,
  tags,
  onChange,
  disabled = false,
  label = "Tags",
}: {
  spaceId: number;
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const { projects } = useSpace();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  // The highlighted suggestion, or -1 for none (Enter then adds the typed tag).
  const [active, setActive] = useState(-1);
  const listId = useId();

  useEffect(() => {
    if (!adding) return;
    const controller = new AbortController();
    getJson<string[]>(`/api/spaces/${spaceId}/tags`, controller.signal)
      .then(setKnown)
      .catch(() => {}); // Suggestions are a convenience; typing a tag still works without them.
    return () => controller.abort();
  }, [adding, spaceId]);

  const query = cleanTag(draft).toLowerCase();
  const taken = new Set(tags.map((t) => t.toLowerCase()));
  const suggestions = query ? known.filter((t) => !taken.has(t.toLowerCase()) && t.toLowerCase().includes(query)) : [];

  function add(tag = draft) {
    setDraft("");
    setActive(-1);
    const next = withTag(tags, tag);
    if (next !== tags) onChange(next);
  }

  function tagStyle(tag: string) {
    const color = projects.find((p) => p.code.toLowerCase() === tag.toLowerCase())?.color;
    return color ? { className: "", style: { color, borderColor: `${color}99` } } : { className: LABEL_TAG };
  }

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => {
        const { className, style } = tagStyle(tag);
        return (
          <span
            key={tag}
            style={style}
            className={`group inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[12px] leading-4 ${className}`}
          >
            {`#${tag}`}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              title="Remove tag"
              disabled={disabled}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="hidden leading-none text-text-muted hover:text-accent focus-visible:inline group-hover:inline group-focus-within:inline disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}
      {adding ? (
        <div className="relative">
          <input
            autoFocus
            role="combobox"
            aria-label="New tag"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            placeholder="tag"
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && suggestions.length > 0) {
                e.preventDefault();
                setActive((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                e.preventDefault();
                setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                add(active >= 0 && active < suggestions.length ? suggestions[active] : undefined);
              } else if (e.key === "Escape") {
                // Closes the input only, not the panel or dialog around it.
                e.stopPropagation();
                setDraft("");
                setActive(-1);
                setAdding(false);
              }
            }}
            onBlur={() => {
              add();
              setAdding(false);
            }}
            className="w-28 rounded border border-border-default bg-transparent print:hidden px-1.5 py-px font-mono text-[12px] leading-4 text-text-primary outline-none focus:border-accent/60"
          />
          {suggestions.length > 0 && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Existing tags"
              className="absolute left-0 top-full z-20 mt-1 max-h-48 min-w-full overflow-y-auto rounded border border-border-strong bg-surface-active py-0.5 shadow-xl shadow-black/40 print:hidden"
            >
              {suggestions.map((tag, i) => (
                <li
                  key={tag}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  // Picked on mouse down, before the input's blur adds the half-typed draft instead.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(tag);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`cursor-pointer whitespace-nowrap px-2 py-0.5 font-mono text-[12px] leading-4 ${
                    i === active ? "bg-accent/15 text-accent" : "text-text-secondary"
                  }`}
                >
                  {`#${tag}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-border-default px-1.5 print:hidden py-px font-mono text-[12px] leading-4 text-text-muted hover:border-accent/60 hover:text-accent disabled:opacity-50"
        >
          + Add tag
        </button>
      )}
    </div>
  );
}
