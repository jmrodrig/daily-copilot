import type { ReactNode } from "react";

/** The page title block used across the views: a small mono eyebrow, the title (with an optional badge) and a subtitle. */
export default function PageHeader({
  eyebrow,
  title,
  badge,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="font-mono text-xs tracking-[0.06em] text-text-muted">{eyebrow}</div>}
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-[28px] font-semibold">{title}</h1>
          {badge}
        </div>
        {subtitle && <div className="mt-1 text-[13px] text-text-muted">{subtitle}</div>}
      </div>
      {actions}
    </header>
  );
}
