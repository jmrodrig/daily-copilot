import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Outlet } from "react-router-dom";

import { CHAT_PROMPT } from "../lib/api";
import { useTaskPanel } from "../lib/tasks";
import CopilotChat from "./CopilotChat";
import Sidebar, { AssistantButton, IconButton, ListeningDot } from "./Sidebar";
import TaskPanel from "./TaskPanel";

const LEFT_KEY = "copilot.leftOpen";
const RIGHT_KEY = "copilot.chatOpen";
const PINNED_KEY = "copilot.chatPinned";
const WIDTHS_KEY = "copilot.paneWidths";

type Pane = "left" | "task" | "chat";
type Widths = Record<Pane, number>;

// Pixel bounds for each resizable pane; the main view keeps at least MAIN_MIN.
const PANES: Record<Pane, { initial: number; min: number; max: number }> = {
  left: { initial: 264, min: 240, max: 480 },
  task: { initial: 400, min: 360, max: 1200 },
  chat: { initial: 400, min: 320, max: 1200 },
};
const MAIN_MIN = 320;
const RAIL = 64; // a collapsed pane
const KEY_STEP = 16;

function useStoredFlag(key: string, fallback = true): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored !== "false";
  });
  useEffect(() => {
    localStorage.setItem(key, String(value));
  }, [key, value]);
  return [value, setValue];
}

const clamp = (pane: Pane, value: number) => Math.min(PANES[pane].max, Math.max(PANES[pane].min, Math.round(value)));

function storedWidths(): Widths {
  let stored: Partial<Widths> = {};
  try {
    stored = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}");
  } catch {
    // Fall back to the defaults.
  }
  const width = (pane: Pane) => (typeof stored[pane] === "number" ? clamp(pane, stored[pane]) : PANES[pane].initial);
  return { left: width("left"), task: width("task"), chat: width("chat") };
}

const measure = (ref: RefObject<HTMLElement | null>) => ref.current?.getBoundingClientRect().width ?? 0;

/**
 * Four columns, left to right: page tree, the current view, the task open via `?taskId=`, and the Co-pilot chat,
 * with draggable dividers between the open ones. Opening a task collapses the chat unless it is pinned; closing the
 * task brings back a chat collapsed that way. The chat is kept mounted (and in the same place in the tree) while
 * collapsed, so the conversation survives.
 */
export default function Layout() {
  const { taskId, closeTask } = useTaskPanel();
  const [leftOpen, setLeftOpen] = useStoredFlag(LEFT_KEY);
  const [chatOpen, setChatOpen] = useStoredFlag(RIGHT_KEY);
  const [isChatPinned, setChatPinned] = useStoredFlag(PINNED_KEY, false);
  const [widths, setWidths] = useState(storedWidths);
  const [resizing, setResizing] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const taskRef = useRef<HTMLElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  // Rendered widths when a drag starts.
  const start = useRef<Widths & { main: number }>({ ...widths, main: 0 });

  const showTask = taskId !== null;
  const taskWasOpen = useRef(false);
  const autoCollapsed = useRef(false);

  useEffect(() => {
    const opening = showTask && !taskWasOpen.current;
    taskWasOpen.current = showTask;
    if (opening) {
      if (chatOpen && !isChatPinned) {
        setChatOpen(false);
        autoCollapsed.current = true;
      }
    } else if (!showTask) {
      if (autoCollapsed.current) setChatOpen(true);
      autoCollapsed.current = false;
    } else if (chatOpen) {
      autoCollapsed.current = false; // expanded by hand while the task is open
    }
  }, [showTask, chatOpen, isChatPinned, setChatOpen]);

  useEffect(() => {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  }, [widths]);

  // A question written into the chat from elsewhere (a listen widget's "Summarize Meeting") opens it to be seen.
  useEffect(() => {
    const open = () => setChatOpen(true);
    window.addEventListener(CHAT_PROMPT, open);
    return () => window.removeEventListener(CHAT_PROMPT, open);
  }, [setChatOpen]);

  // Shrink the open panes (the chat first, then the task, then the page tree) when the window is too narrow for them
  // and the main view, so the chat (and its scrollbar) never runs off the right edge.
  useEffect(() => {
    function fit() {
      const available = rootRef.current?.clientWidth || window.innerWidth;
      setWidths((prev) => {
        const dividers = Number(leftOpen) + Number(showTask || chatOpen) + Number(showTask && chatOpen);
        const total =
          (leftOpen ? prev.left : RAIL) + (showTask ? prev.task : 0) + (chatOpen ? prev.chat : RAIL) + dividers + MAIN_MIN;
        let excess = total - available;
        if (excess <= 0) return prev;
        const next = { ...prev };
        const isOpen: Record<Pane, boolean> = { chat: chatOpen, task: showTask, left: leftOpen };
        const open = (["chat", "task", "left"] as const).filter((pane) => isOpen[pane]);
        for (const pane of open) {
          const cut = Math.min(excess, next[pane] - PANES[pane].min);
          if (cut <= 0) continue;
          next[pane] -= cut;
          excess -= cut;
          if (excess <= 0) break;
        }
        return open.some((pane) => next[pane] !== prev[pane]) ? next : prev;
      });
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [leftOpen, showTask, chatOpen]);

  function beginResize() {
    start.current = {
      left: measure(leftRef) || widths.left,
      task: measure(taskRef) || widths.task,
      chat: measure(chatRef) || widths.chat,
      main: measure(mainRef),
    };
  }

  // Prevent text selection across the document and keep the resize cursor stable during drag.
  useEffect(() => {
    if (!resizing) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [resizing]);

  /** Grows `pane` by `grow` pixels from its width at the start of the drag, taking the room from the main view. */
  function resizeAgainstMain(pane: Pane, grow: number) {
    const s = start.current;
    // When shrinking (grow < 0), room in main is not a blocker; when expanding (grow > 0), do not crush main below MAIN_MIN.
    const room = Math.max(0, s.main - MAIN_MIN);
    const delta = grow > 0 ? Math.min(grow, room) : grow;
    setWidths((prev) => ({ ...prev, [pane]: clamp(pane, s[pane] + delta) }));
  }

  /** Moves the task/chat border by `dx` pixels, trading width between the two. */
  function resizeTaskAndChat(dx: number) {
    const s = start.current;
    const lo = Math.max(PANES.task.min - s.task, s.chat - PANES.chat.max);
    const hi = Math.min(PANES.task.max - s.task, s.chat - PANES.chat.min);
    const shift = Math.min(hi, Math.max(lo, dx));
    setWidths((prev) => ({ ...prev, task: clamp("task", s.task + shift), chat: clamp("chat", s.chat - shift) }));
  }

  const reset = (...panes: Pane[]) =>
    setWidths((prev) => ({ ...prev, ...Object.fromEntries(panes.map((pane) => [pane, PANES[pane].initial])) }));

  const dividerProps = { onStart: beginResize, onResizingChange: setResizing };
  // The pane next to the main view on the right: the task when one is open, else the chat if expanded.
  const rightOfMain: Pane | null = showTask ? "task" : chatOpen ? "chat" : null;
  // Panes hold their width in the row (the effect above makes room for the main view when the window narrows).
  const paneStyle = (pane: Pane) => ({ width: widths[pane], minWidth: widths[pane] });
  const railStyle = { width: RAIL, minWidth: RAIL };
  // Animate collapse/expand, but not while a divider is dragged, so resizing tracks the pointer.
  const paneTransition = resizing ? "" : "transition-[width,min-width] duration-200 ease-out motion-reduce:transition-none";

  return (
    <div ref={rootRef} className="flex h-full min-h-[720px] overflow-hidden text-sm leading-[1.45] print:block print:h-auto print:min-h-0 print:overflow-visible">
      <nav
        ref={leftRef}
        aria-label="Page tree"
        style={leftOpen ? paneStyle("left") : railStyle}
        className={`flex flex-col overflow-hidden print:hidden bg-surface-panel ${leftOpen ? "" : "shrink-0 border-r border-border-default"} ${paneTransition}`}
      >
        {leftOpen ? (
          <Sidebar onCollapse={() => setLeftOpen(false)} />
        ) : (
          <div className="flex flex-col items-center gap-3 py-3.5">
            <IconButton label="Expand page tree" onClick={() => setLeftOpen(true)} direction="right" />
            <ListeningDot />
          </div>
        )}
      </nav>
      {leftOpen && (
        <Divider
          {...dividerProps}
          label="Resize page tree"
          value={widths.left}
          onMove={(dx) => resizeAgainstMain("left", dx)}
          onReset={() => reset("left")}
        />
      )}
      <main ref={mainRef} className="min-w-[320px] flex-1 overflow-auto print:overflow-visible">
        <Outlet />
      </main>
      {rightOfMain && (
        <Divider
          {...dividerProps}
          label={rightOfMain === "task" ? "Resize task details" : "Resize chat"}
          value={widths[rightOfMain]}
          onMove={(dx) => resizeAgainstMain(rightOfMain, -dx)}
          onReset={() => reset(rightOfMain)}
        />
      )}
      {showTask && (
        <aside
          ref={taskRef}
          aria-label="Task details"
          style={paneStyle("task")}
          className="flex animate-pane-in flex-col overflow-hidden print:hidden bg-surface-panel motion-reduce:animate-none"
        >
          <TaskPanel taskId={taskId} onClose={closeTask} />
        </aside>
      )}
      {showTask && chatOpen && (
        <Divider
          {...dividerProps}
          label="Resize task details and chat"
          value={widths.task}
          onMove={resizeTaskAndChat}
          onReset={() => reset("task", "chat")}
        />
      )}
      <aside
        ref={chatRef}
        aria-label="Co-pilot"
        style={chatOpen ? paneStyle("chat") : railStyle}
        className={`flex flex-col overflow-hidden print:hidden bg-surface-panel ${
          chatOpen ? "" : "shrink-0 items-center border-l border-border-default py-3.5"
        } ${paneTransition}`}
      >
        {!chatOpen && <AssistantButton label="AI Assistant" title="Open AI Assistant" onClick={() => setChatOpen(true)} />}
        <div className={chatOpen ? "min-h-0 flex-1" : "hidden"}>
          <CopilotChat
            active={chatOpen}
            onCollapse={() => setChatOpen(false)}
            pinned={isChatPinned}
            onPinnedChange={setChatPinned}
          />
        </div>
      </aside>
    </div>
  );
}

/**
 * A vertical drag handle between two columns. It draws the 1px border between them, with a wider invisible grip;
 * `onMove` gets the horizontal distance from where the drag (or arrow-key nudge) started.
 */
function Divider({
  label,
  value,
  onStart,
  onMove,
  onReset,
  onResizingChange,
}: {
  label: string;
  value: number;
  onStart: () => void;
  onMove: (dx: number) => void;
  onReset: () => void;
  onResizingChange: (resizing: boolean) => void;
}) {
  const startX = useRef(0);

  function down(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    startX.current = event.clientX;
    onStart();
    onResizingChange(true);
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) onMove(event.clientX - startX.current);
  }

  function up(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizingChange(false);
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onStart();
    onMove(step);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={drag}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={() => onResizingChange(false)}
      onDoubleClick={onReset}
      onKeyDown={nudge}
      title="Drag to resize · double-click to reset"
      className="group relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-border-default print:hidden focus:outline-none"
    >
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 opacity-0 group-hover:bg-accent/60 group-hover:opacity-100 group-focus-visible:bg-accent group-focus-visible:opacity-100" />
    </div>
  );
}
