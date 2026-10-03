import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import CopilotChat from "./CopilotChat";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", short: "D", end: true },
  { to: "/check-in", label: "Evening Check-in", short: "E", end: false },
  { to: "/projects", label: "Projects", short: "P", end: false },
  { to: "/knowledge", label: "Knowledge Base", short: "K", end: false },
];

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="flex h-full">
      <aside
        className={`flex shrink-0 flex-col border-r border-border-default bg-surface-panel transition-[width] duration-150 ${
          collapsed ? "w-14" : "w-56"
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-border-default px-3">
          {!collapsed && <span className="text-sm font-semibold tracking-wide">Daily Co-Pilot</span>}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised hover:text-text-primary"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
        <nav className="flex flex-col gap-1 p-2">
          {NAV_ITEMS.map(({ to, label, short, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                `rounded border-l-2 px-3 py-2 text-sm ${
                  isActive
                    ? "border-accent bg-surface-raised text-text-primary"
                    : "border-transparent text-text-secondary hover:bg-surface-raised hover:text-text-primary"
                }`
              }
            >
              {collapsed ? short : label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-border-default p-2">
          <button
            type="button"
            onClick={() => setChatOpen((o) => !o)}
            title="Co-pilot chat"
            aria-pressed={chatOpen}
            className={`w-full rounded border-l-2 px-3 py-2 text-left text-sm ${
              chatOpen
                ? "border-accent bg-surface-raised text-text-primary"
                : "border-transparent text-text-secondary hover:bg-surface-raised hover:text-text-primary"
            }`}
          >
            {collapsed ? "C" : "Co-pilot"}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto bg-background p-8">
        <Outlet />
      </main>
      {/* Kept mounted while closed so the conversation survives page changes. */}
      <CopilotChat open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}
