import { useEffect, useRef, useState, type ReactNode } from "react";

export type MultiOption<T> = { value: T; label: string };

/**
 * A filter that picks any number of values: a button showing what's picked that drops down a list of checkboxes,
 * with "Any" at the top to clear them. Nothing picked means the filter is off.
 */
export default function MultiSelect<T extends string | number>({
  label,
  options,
  value,
  onChange,
  anyLabel = "Any",
  className = "w-40",
}: {
  /** What is being filtered, for screen readers ("Priority"). */
  label: string;
  options: MultiOption<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  anyLabel?: string;
  /** Classes for the button (its width, mostly). */
  className?: string;
}) {
  const picked = new Set(value);
  const labels = options.filter((o) => picked.has(o.value)).map((o) => o.label);
  const summary = labels.length === 0 ? anyLabel : labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;

  function toggle(option: T) {
    onChange(picked.has(option) ? value.filter((v) => v !== option) : [...value, option]);
  }

  return (
    <Dropdown
      label={label}
      summary={summary}
      title={labels.length > 2 ? labels.join(", ") : undefined}
      active={labels.length > 0}
      className={className}
    >
      <Row checked={value.length === 0} onChange={() => onChange([])}>
        {anyLabel}
      </Row>
      {options.length > 0 && <div role="separator" className="my-1 border-t border-border-default" />}
      {options.map((option) => (
        <Row key={option.value} checked={picked.has(option.value)} onChange={() => toggle(option.value)}>
          {option.label}
        </Row>
      ))}
    </Dropdown>
  );
}

/** A button that drops down a list of checkbox `Row`s; closes on a click outside or Escape. */
export function Dropdown({
  label,
  summary,
  title,
  active = false,
  align = "left",
  className = "",
  children,
}: {
  label: string;
  summary: string;
  title?: string;
  /** Highlights the button (a filter that is on). */
  active?: boolean;
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={summary === label ? label : `${label}: ${summary}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`field flex items-center justify-between gap-2 py-1 text-left text-[13px] ${className} ${
          active ? "border-accent/60 text-text-primary" : "text-text-secondary"
        }`}
      >
        <span className="truncate">{summary}</span>
        <svg aria-hidden viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          aria-multiselectable
          className={`absolute top-full z-30 mt-1 max-h-72 w-max min-w-full max-w-xs overflow-y-auto rounded-lg border border-border-strong bg-surface-active p-1 text-[13px] normal-case tracking-normal shadow-xl shadow-black/40 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** One checkbox of a `Dropdown`. */
export function Row({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label
      role="option"
      aria-selected={checked}
      aria-disabled={disabled || undefined}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 font-normal ${
        disabled ? "cursor-default opacity-60" : "cursor-pointer hover:bg-surface-raised"
      } ${checked ? "text-text-primary" : "text-text-secondary"}`}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="accent-accent" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </label>
  );
}
