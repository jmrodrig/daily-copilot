import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { ProjectOption } from "../lib/tasks";
import Popover from "./Popover";
import { ProjectTag } from "./TriageBoard";

/** Whether a project's name says more than its code (so it's worth showing beside the code's pill). */
function hasDistinctName(project: ProjectOption | null | undefined): project is ProjectOption {
  return Boolean(project?.name && project.code && project.name.trim().toLowerCase() !== project.code.trim().toLowerCase());
}

/** A project as text: its code, then its name if that differs. */
export function projectLabel(project: ProjectOption): string {
  const { code, name } = project;
  return hasDistinctName(project) ? `${code} · ${name}` : code;
}

/**
 * A project as its coloured pill (and its name, if that differs from the code); clicking it lists the projects to
 * pick another (or none). Arrow keys, Home and End move through the list; Escape closes it unchanged. Without a
 * `className` it's a bare pill (for a table cell or a row of chips); with one, styled like a form field.
 */
export function ProjectPicker({
  value,
  projects,
  onChange,
  className,
  ariaLabel = "Project",
  emptyLabel = "No project",
  disabled,
}: {
  value: number | null;
  projects: ProjectOption[];
  onChange: (projectId: number | null) => void;
  className?: string;
  ariaLabel?: string;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const project = projects.find((p) => p.id === value);
  const label = project ? projectLabel(project) : emptyLabel;

  // Opened, the current choice takes the focus, so the arrow keys move on from it.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = menuItems();
      (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function menuItems(): HTMLElement[] {
    return Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  }

  function pick(projectId: number | null) {
    setOpen(false);
    button.current?.focus();
    if (projectId !== value) onChange(projectId);
  }

  function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape" || e.key === "Tab") {
      // Escape closes just the menu, not a panel around it.
      if (e.key === "Escape") e.stopPropagation();
      e.preventDefault();
      pick(value);
    }
    if (next !== null) {
      e.preventDefault();
      items[next]?.focus();
    }
  }

  function buttonKeys(e: KeyboardEvent<HTMLButtonElement>) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
      e.preventDefault();
      setOpen(true);
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-label={`${ariaLabel}: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled ? label : `${label} · click to change`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={buttonKeys}
        className={
          className
            ? `${className} gap-2 text-left disabled:opacity-60`
            : "flex min-w-0 items-center gap-1 rounded hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:opacity-60"
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">
            <ProjectTag code={project ? project.code : emptyLabel} color={project?.color} />
          </span>
          {hasDistinctName(project) && <span className="truncate text-xs text-text-muted">{project.name}</span>}
        </span>
        <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5 shrink-0 text-text-muted">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Popover anchor={button} open={open} onClose={() => setOpen(false)} label={`${ariaLabel} options`} role="menu">
        <div ref={menu} onKeyDown={menuKeys}>
          {[null, ...projects].map((p) => {
            const id = p?.id ?? null;
            const selected = id === value;
            return (
              <button
                key={id ?? "none"}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={-1}
                onClick={() => pick(id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised focus:bg-surface-raised focus:outline-none ${
                  selected ? "bg-surface-raised/60 text-text-primary" : "text-text-secondary"
                }`}
              >
                <ProjectTag code={p ? p.code : emptyLabel} color={p?.color} />
                {hasDistinctName(p) && <span className="truncate">{p.name}</span>}
                {selected && (
                  <svg aria-hidden viewBox="0 0 12 12" className="ml-auto h-3 w-3 shrink-0 text-accent">
                    <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
