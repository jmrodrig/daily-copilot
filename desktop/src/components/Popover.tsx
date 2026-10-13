import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Position = { left?: number; right?: number; top: number; minWidth: number; maxHeight: number; above: boolean };

const GAP = 4;
const MAX_HEIGHT = 288;

/**
 * A list floating under (or, near the bottom of the window, over) `anchor`, drawn in a portal so a table's or a
 * column's overflow doesn't clip it. Follows the anchor as the page scrolls; a mousedown outside both closes it.
 */
export default function Popover({
  anchor,
  open,
  onClose,
  id,
  label,
  role = "listbox",
  align = "start",
  className = "",
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  id?: string;
  label: string;
  role?: "listbox" | "menu" | "dialog";
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - GAP * 2;
      const above = below < 160 && rect.top > below;
      const maxHeight = Math.min(MAX_HEIGHT, Math.max(120, (above ? rect.top : below) - GAP));
      const top = above ? rect.top - GAP : rect.bottom + GAP;
      const panelWidth = panel.current?.offsetWidth ?? 0;
      const shouldAlignEnd = align === "end" || (panelWidth > 0 && rect.left + panelWidth > window.innerWidth - GAP);

      if (shouldAlignEnd) {
        const right = Math.max(GAP, window.innerWidth - rect.right);
        setPosition({
          right,
          top,
          minWidth: rect.width,
          maxHeight,
          above,
        });
      } else {
        const left = Math.max(GAP, panelWidth > 0 ? Math.min(rect.left, window.innerWidth - panelWidth - GAP) : rect.left);
        setPosition({
          left,
          top,
          minWidth: rect.width,
          maxHeight,
          above,
        });
      }
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, align]);

  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const el = panel.current;
    const observer = new ResizeObserver(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - GAP * 2;
      const above = below < 160 && rect.top > below;
      const maxHeight = Math.min(MAX_HEIGHT, Math.max(120, (above ? rect.top : below) - GAP));
      const top = above ? rect.top - GAP : rect.bottom + GAP;
      const panelWidth = el.offsetWidth;
      const shouldAlignEnd = align === "end" || (panelWidth > 0 && rect.left + panelWidth > window.innerWidth - GAP);

      if (shouldAlignEnd) {
        const right = Math.max(GAP, window.innerWidth - rect.right);
        setPosition((prev) =>
          prev && prev.right === right && prev.top === top && prev.maxHeight === maxHeight && prev.above === above
            ? prev
            : { right, top, minWidth: rect.width, maxHeight, above }
        );
      } else {
        const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - panelWidth - GAP));
        setPosition((prev) =>
          prev && prev.left === left && prev.top === top && prev.maxHeight === maxHeight && prev.above === above
            ? prev
            : { left, top, minWidth: rect.width, maxHeight, above }
        );
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) close.current();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, anchor]);

  if (!open || !position) return null;
  return createPortal(
    <div
      ref={panel}
      id={id}
      data-popover
      role={role}
      aria-label={label}
      style={{
        left: position.left,
        right: position.right,
        top: position.top,
        minWidth: position.minWidth,
        maxHeight: position.maxHeight,
        transform: position.above ? "translateY(-100%)" : undefined,
      }}
      className={`fixed z-50 w-max max-w-xs overflow-y-auto rounded-lg border border-border-strong bg-surface-active p-1 text-[13px] normal-case tracking-normal shadow-xl shadow-black/40 ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
