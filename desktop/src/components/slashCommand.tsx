import { Extension, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useState, type MutableRefObject } from "react";

import { MicIcon } from "./ListenWidget";
import { WhiteboardIcon } from "./markupUi";
import { PillIcon, type RefKind } from "./referencePill";

/** What `/` offers: insert a new task, a link to a task, a note or a web page, a whiteboard, or a listen widget. */
export type SlashItem = {
  id: "task" | "link" | "whiteboard" | "listen";
  title: string;
  description: string;
  icon: RefKind | "whiteboard" | "listen";
  keywords: string[];
};

const SLASH_ITEMS: SlashItem[] = [
  { id: "task", title: "Task", description: "Create a task and insert it here", icon: "task", keywords: ["todo", "action"] },
  { id: "link", title: "Link", description: "Link a task, a note or a URL", icon: "url", keywords: ["note", "url", "page", "reference"] },
  { id: "whiteboard", title: "Whiteboard", description: "Draw, and pin images and PDFs", icon: "whiteboard", keywords: ["draw", "canvas", "sketch", "diagram", "board"] },
  { id: "listen", title: "Listen", description: "Record and transcribe a meeting or call", icon: "listen", keywords: ["record", "voice", "audio", "meeting", "transcribe", "mic", "call"] },
];

/** The open menu: the matching items, where the `/` is on screen, and how to pick one. */
export type SlashMenuState = { items: SlashItem[]; rect: DOMRect | null; pick: (item: SlashItem) => void };

export type SlashCommandOptions = {
  /** The menu opened, its items changed, or (null) it closed. */
  onChange: (state: SlashMenuState | null) => void;
  /** A key pressed while the menu is open: true if the menu used it. */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** An item was picked; the `/` and its query (`range`) are still in the doc. */
  onPick: (item: SlashItem, range: Range) => void;
};

/** Typing `/` at the start of a line or after a space opens a menu of commands, filtered by what follows it. */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return { onChange: () => {}, onKeyDown: () => false, onPick: () => {} };
  },

  addProseMirrorPlugins() {
    const { onChange, onKeyDown, onPick } = this.options;
    const state = (props: SuggestionProps<SlashItem, SlashItem>): SlashMenuState => ({
      items: props.items,
      rect: props.clientRect?.() ?? null,
      pick: props.command,
    });
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashCommand"),
        char: "/",
        // Not in code, where a slash is just a slash.
        allow: ({ state: s, range }) => !s.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => {
          const q = query.toLowerCase().trim();
          return SLASH_ITEMS.filter((item) => [item.title.toLowerCase(), ...item.keywords].some((word) => word.startsWith(q)));
        },
        command: ({ range, props }) => onPick(props, range),
        render: () => ({
          onStart: (props) => onChange(state(props)),
          onUpdate: (props) => onChange(state(props)),
          onExit: () => onChange(null),
          onKeyDown: ({ event }) => event.key !== "Escape" && onKeyDown(event),
        }),
      }),
    ];
  },
});

/**
 * The `/` menu under the caret: arrow keys move through it, Enter or Tab picks, Escape closes it (the editor keeps
 * its focus throughout). `keyHandler` is pointed at this menu's key handling while it's shown.
 */
export function SlashMenu({ menu, keyHandler }: { menu: SlashMenuState; keyHandler: MutableRefObject<(event: KeyboardEvent) => boolean> }) {
  const [active, setActive] = useState(0);
  const { items, rect, pick } = menu;
  const index = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    keyHandler.current = (event) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (Math.min(i, items.length - 1) + step + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        pick(items[index]);
        return true;
      }
      return false;
    };
    return () => {
      keyHandler.current = () => false;
    };
  }, [items, index, pick, keyHandler]);

  if (!items.length || !rect) return null;
  return (
    <div
      role="listbox"
      aria-label="Insert"
      style={{ top: Math.min(rect.bottom + 6, window.innerHeight - 140), left: Math.min(rect.left, window.innerWidth - 268) }}
      className="fixed z-30 flex w-64 flex-col overflow-hidden rounded-lg border border-border-default bg-surface-raised py-1 shadow-xl"
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === index}
          // Keep the editor's focus and the `/` query until the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(item)}
          className={`flex items-center gap-2.5 px-3 py-2 text-left ${i === index ? "bg-surface-hover" : ""}`}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-default text-accent-soft">
            {item.icon === "whiteboard" ? (
              <WhiteboardIcon size={15} />
            ) : item.icon === "listen" ? (
              <MicIcon size={15} />
            ) : (
              <PillIcon kind={item.icon} size={15} />
            )}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[15px] text-text-primary">{item.title}</span>
            <span className="truncate text-xs text-text-muted">{item.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
