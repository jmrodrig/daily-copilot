import { useEffect, useRef, useState, type ReactNode } from "react";

import { INKS, isEraser, SIZES, type Comment, type Eraser, type Tool } from "./markupCore";

/** The erasers, which share a split button in the toolbar, with their icons (paths in a 16 × 16 box). */
export const ERASERS: { tool: Eraser; name: string; label: string; icon: string }[] = [
  {
    tool: "lasso-erase",
    name: "Lasso eraser",
    label: "Lasso eraser: loop around ink to delete it",
    // A lasso's loop, its rope running down to an eraser's block.
    icon: "M7 2c2.8 0 5 1.3 5 3s-2.2 3-5 3-5-1.3-5-3 2.2-3 5-3z M5.4 7.8c-.6 1.2-.2 2.6 1.2 3.2.9.4 1.9.7 2.7 1.5 M8.6 13.2l3.6-3.6a.7.7 0 0 1 1 0l1.2 1.2a.7.7 0 0 1 0 1L12 14.2H9.6z M10.4 11.4l2.2 2.2",
  },
  {
    tool: "erase",
    name: "Stroke eraser",
    label: "Stroke eraser: a stylus or the mouse deletes the ink it touches",
    icon: "M6 13.5h7.5 M2.8 9.7l6.5-6.5a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4L7.6 13H5.1z M6 6.5l4 4",
  },
];

/** A speech bubble, in a 16 × 16 box. */
export const COMMENT_ICON = "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z";

/** The markup tools, with their icons (paths in a 16 × 16 box, dashed for some). */
export const TOOLS: { tool: Tool; label: string; icon: string; dashed?: boolean }[] = [
  { tool: "draw", label: "Pen: a stylus or the mouse draws", icon: "M10.5 2.5l3 3-8 8H2.5v-3z M8.5 4.5l3 3" },
  ...ERASERS,
  {
    tool: "select",
    label: "Select: loop around ink, then drag it to move it, its corners to scale it or its top handle to turn it (Delete removes it)",
    icon: "M8 2.5c3.3 0 5.5 1.6 5.5 3.6S11.3 9.7 8 9.7 2.5 8.1 2.5 6.1 4.7 2.5 8 2.5z M5.2 9.2c-.9.9-.8 2.4.3 3 .9.5 1.4 1 1.2 2.3",
    dashed: true,
  },
  { tool: "line", label: "Line: drag to draw one", icon: "M3 13L13 3" },
  { tool: "arrow", label: "Arrow: drag from its tail to its head", icon: "M3 13L13 3 M7 3h6v6" },
  { tool: "rect", label: "Rectangle: drag across its corners", icon: "M2.5 4h11v8h-11z" },
  { tool: "circle", label: "Ellipse: drag across its bounds", icon: "M14 8a6 4.5 0 1 1-12 0a6 4.5 0 1 1 12 0z" },
  { tool: "text", label: "Text: click to type some", icon: "M3 4.5V3h10v1.5 M8 3v10 M6 13h4" },
  { tool: "comment", label: "Comment: click to pin a sticky note there", icon: COMMENT_ICON },
  { tool: "pan", label: "Move: a stylus or the mouse pans", icon: "M8 1.5v13 M1.5 8h13 M6 3.5l2-2 2 2 M6 12.5l2 2 2-2 M3.5 6l-2 2 2 2 M12.5 6l2 2-2 2" },
];

/** A whiteboard: a board on a stand, with a squiggle on it. */
export function WhiteboardIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.7" y="2.2" width="12.6" height="9.3" rx="1.2" />
      <path d="M4.2 8.8c1.2-2.4 2.2-2.6 3-.9.7 1.5 1.6 1.4 2.6-.6 M8 11.5v2.3 M5.5 13.8h5" />
    </svg>
  );
}

/** A tool's icon: a path in a 16 × 16 box, maybe dashed. */
export function ToolIcon({ path, dashed }: { path: string; dashed?: boolean }) {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} strokeDasharray={dashed ? "2 2.5" : undefined} />
    </svg>
  );
}

export function Segment({
  on,
  label,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 min-w-8 items-center justify-center rounded px-2 text-[15px] disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />;
}

/**
 * The markup tools' part of a toolbar: a button per tool (the erasers sharing a split button, the eraser last picked
 * and a menu to pick the other), then the inks and the line widths. The eraser's menu is the caller's state, so its
 * Escape handling can close it before anything else.
 */
export function MarkupTools({
  tool,
  onTool,
  eraser,
  onEraser,
  eraserMenu,
  onEraserMenu,
  ink,
  onInk,
  lineSize,
  onLineSize,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  eraser: Eraser;
  onEraser: (eraser: Eraser) => void;
  eraserMenu: boolean;
  onEraserMenu: (open: boolean) => void;
  ink: string;
  onInk: (ink: string) => void;
  lineSize: number;
  onLineSize: (size: number) => void;
}) {
  const eraserMenuRef = useRef<HTMLSpanElement>(null);

  // The eraser's menu closes on a click outside it.
  useEffect(() => {
    if (!eraserMenu) return;
    const outside = (e: PointerEvent) => {
      if (!eraserMenuRef.current?.contains(e.target as Node)) onEraserMenu(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [eraserMenu, onEraserMenu]);

  return (
    <>
      {TOOLS.map((t) =>
        !isEraser(t.tool) ? (
          <Segment key={t.tool} on={tool === t.tool} label={t.label} onClick={() => onTool(t.tool)}>
            <ToolIcon path={t.icon} dashed={t.dashed} />
          </Segment>
        ) : (
          t.tool === eraser && (
            <span key="eraser" ref={eraserMenuRef} className="relative flex items-center">
              <Segment on={tool === t.tool} label={`${t.label} (or hold Shift)`} onClick={() => onTool(t.tool)}>
                <ToolIcon path={t.icon} />
              </Segment>
              <button
                type="button"
                title="Choose the eraser"
                aria-label="Choose the eraser"
                aria-haspopup="menu"
                aria-expanded={eraserMenu}
                onClick={() => onEraserMenu(!eraserMenu)}
                className="flex h-8 w-4 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
              >
                <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 3l2.5 2.5L6.5 3" />
                </svg>
              </button>
              {eraserMenu && (
                <div role="menu" aria-label="Eraser" className="absolute left-0 top-full z-20 mt-1 min-w-[200px] rounded-lg border border-border-light bg-surface-raised py-1 shadow-xl">
                  {ERASERS.map((e) => (
                    <button
                      key={e.tool}
                      type="button"
                      role="menuitemradio"
                      aria-checked={eraser === e.tool}
                      onClick={() => {
                        onEraser(e.tool);
                        onTool(e.tool);
                        onEraserMenu(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[15px] hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:outline-none ${
                        eraser === e.tool ? "text-accent-soft" : "text-text-secondary"
                      }`}
                    >
                      <ToolIcon path={e.icon} />
                      {e.name}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )
        ),
      )}
      <ToolbarDivider />
      {INKS.map((c) => (
        <button
          key={c.value}
          type="button"
          title={c.name}
          aria-label={c.name}
          aria-pressed={ink === c.value}
          onClick={() => onInk(c.value)}
          className={`h-6 w-6 rounded-full border-2 ${ink === c.value ? "border-text-primary" : "border-transparent"}`}
          style={{ background: c.value }}
        />
      ))}
      <ToolbarDivider />
      {SIZES.map((s) => (
        <button
          key={s}
          type="button"
          title={`Line width ${s}`}
          aria-label={`Line width ${s}`}
          aria-pressed={lineSize === s}
          onClick={() => onLineSize(s)}
          className={`flex h-8 w-8 items-center justify-center rounded ${lineSize === s ? "bg-accent/[0.16]" : "hover:bg-surface-raised"}`}
        >
          <span className="rounded-full bg-text-primary" style={{ width: s + 2, height: s + 2 }} />
        </button>
      ))}
    </>
  );
}

/**
 * A comment, pinned where it was placed: in surface units, like the canvas, so it stays on its spot as the view pans
 * and zooms, but scaled back to stay the same size on screen. Collapsed, it's an icon, which a click opens to a
 * sticky note: written in and saved (which collapses it again) while `editable`, else just read.
 */
export function CommentPin({
  comment,
  zoom,
  editable,
  onToggle,
  onSave,
  onDelete,
}: {
  comment: Comment;
  zoom: number;
  editable: boolean;
  onToggle: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(comment.text);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Opening it starts from what's saved, in the field, once the click that opened it is done.
  useEffect(() => {
    if (!comment.isExpanded) return;
    setDraft(comment.text);
    const timer = setTimeout(() => fieldRef.current?.focus());
    return () => clearTimeout(timer);
  }, [comment.isExpanded]);

  return (
    <div
      className="absolute"
      style={{ left: comment.x, top: comment.y, transform: `scale(${1 / zoom})`, transformOrigin: "0 0" }}
      // Clicking and typing in it isn't drawing on, or panning, the stage.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title={comment.text || "Comment"}
        aria-label={comment.isExpanded ? "Close the comment" : "Open the comment"}
        aria-expanded={comment.isExpanded}
        onClick={onToggle}
        className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white shadow-lg ${
          comment.isExpanded ? "bg-accent text-white" : "bg-yellow-300 text-neutral-900 hover:scale-110"
        }`}
      >
        <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d={COMMENT_ICON} />
        </svg>
      </button>
      {comment.isExpanded && (
        <div role="note" className="absolute left-5 top-2 w-64 cursor-auto rounded-md bg-yellow-100 p-2 text-neutral-900 shadow-xl">
          {editable ? (
            <>
              <textarea
                ref={fieldRef}
                aria-label="Comment"
                value={draft}
                rows={4}
                placeholder="Write a comment…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onSave(draft);
                  }
                }}
                className="block w-full resize-none select-text rounded border border-yellow-300 bg-yellow-50 p-1.5 text-sm text-neutral-900 placeholder:text-neutral-500 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                {comment.text && (
                  <button type="button" onClick={onDelete} className="mr-auto rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-yellow-200">
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onSave(draft)}
                  title="Save (Ctrl+Enter)"
                  className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-yellow-50 hover:bg-neutral-700"
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <p className="max-h-60 select-text overflow-auto whitespace-pre-wrap text-sm">{comment.text}</p>
          )}
        </div>
      )}
    </div>
  );
}
