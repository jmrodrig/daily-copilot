import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import CopilotChat from "./CopilotChat";
import Sidebar, { IconButton } from "./Sidebar";

const LEFT_KEY = "copilot.leftOpen";
const RIGHT_KEY = "copilot.chatOpen";

function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) !== "false");
  useEffect(() => {
    localStorage.setItem(key, String(value));
  }, [key, value]);
  return [value, setValue];
}

/** Three panes, as in the mockups: page tree, the current view, and the Co-pilot chat. */
export default function Layout() {
  const [leftOpen, setLeftOpen] = useStoredFlag(LEFT_KEY);
  const [chatOpen, setChatOpen] = useStoredFlag(RIGHT_KEY);

  return (
    <div className="flex h-full min-h-[720px] overflow-hidden text-sm leading-[1.45]">
      <nav
        aria-label="Page tree"
        className={`flex shrink-0 flex-col overflow-hidden border-r border-border-default bg-surface-panel transition-[width] duration-200 ${
          leftOpen ? "w-[264px]" : "w-16"
        }`}
      >
        {leftOpen ? (
          <Sidebar onCollapse={() => setLeftOpen(false)} />
        ) : (
          <div className="flex flex-col items-center py-3.5">
            <IconButton label="Expand page tree" onClick={() => setLeftOpen(true)} direction="right" />
          </div>
        )}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
      {/* Kept mounted while collapsed so the conversation survives page changes. */}
      <CopilotChat open={chatOpen} onOpenChange={setChatOpen} />
    </div>
  );
}
