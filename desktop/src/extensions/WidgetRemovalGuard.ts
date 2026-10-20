import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

/**
 * Why an edit that removes a block widget asks first. A listen widget: it's recording (or being transcribed), it holds
 * a recording, or it's yet to record. A whiteboard or a spreadsheet (`id` is where it was, as they have no id of
 * their own).
 */
export type WidgetRemoval =
  | { type: "listen"; reason: "listening" | "recorded" | "idle"; id: string }
  | { type: "whiteboard"; id: string }
  | { type: "spreadsheet"; id: string };

/** Set on an edit that removes a widget, once the removal is confirmed, for WidgetRemovalGuard to let it through. */
export const WIDGET_REMOVAL_CONFIRMED = "widgetRemovalConfirmed";

type ListenNodeData = { id: string; status?: string };

// A listen node's data, parsed once per node (nodes don't change: an edit makes new ones).
const parsedListenNodes = new WeakMap<ProseMirrorNode, ListenNodeData | null>();

function listenData(node: ProseMirrorNode): ListenNodeData | null {
  let data = parsedListenNodes.get(node);
  if (data === undefined) {
    data = null;
    try {
      const raw = typeof node.attrs.data === "string" ? JSON.parse(node.attrs.data) : null;
      if (raw && typeof raw === "object" && typeof raw.id === "string" && raw.id) data = raw as ListenNodeData;
    } catch {
      // Unreadable: not guarded (its widget offers to remove it).
    }
    parsedListenNodes.set(node, data);
  }
  return data;
}

/** The listen widgets in `doc` (by id), and where its whiteboards and spreadsheets are. */
function widgets(doc: ProseMirrorNode): { listens: Map<string, ListenNodeData>; whiteboards: number[]; spreadsheets: number[] } {
  const listens = new Map<string, ListenNodeData>();
  const whiteboards: number[] = [];
  const spreadsheets: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "listen") {
      const data = listenData(node);
      if (data) listens.set(data.id, data);
      return false;
    }
    if (node.type.name === "whiteboard") {
      whiteboards.push(pos);
      return false;
    }
    if (node.type.name === "spreadsheet") {
      spreadsheets.push(pos);
      return false;
    }
    return !node.isTextblock;
  });
  return { listens, whiteboards, spreadsheets };
}

/**
 * What removing widgets in `tr` would lose, the worst of it if it takes out several (a recording in progress, then a
 * recorded one, then a whiteboard, then a spreadsheet, then a listen widget yet to record); null if it removes none. `activeWidget` is the
 * id of the listen widget recording or being transcribed, if any.
 */
export function widgetRemoval(tr: Transaction, activeWidget: string | null): WidgetRemoval | null {
  const before = widgets(tr.before);
  if (!before.listens.size && !before.whiteboards.length && !before.spreadsheets.length) return null;
  const after = widgets(tr.doc);

  const removed = [...before.listens.values()].filter((data) => !after.listens.has(data.id));
  const listening = removed.find((data) => data.id === activeWidget);
  if (listening) return { type: "listen", reason: "listening", id: listening.id };
  const recorded = removed.find((data) => data.status === "completed");
  if (recorded) return { type: "listen", reason: "recorded", id: recorded.id };

  // A whiteboard's drawing changes it in place, so fewer of them means one's gone: the first one the edit deleted.
  if (after.whiteboards.length < before.whiteboards.length) {
    const gone = before.whiteboards.find((pos) => tr.mapping.mapResult(pos, 1).deletedAfter) ?? before.whiteboards[0];
    return { type: "whiteboard", id: `whiteboard@${gone}` };
  }
  // A spreadsheet, likewise.
  if (after.spreadsheets.length < before.spreadsheets.length) {
    const gone = before.spreadsheets.find((pos) => tr.mapping.mapResult(pos, 1).deletedAfter) ?? before.spreadsheets[0];
    return { type: "spreadsheet", id: `spreadsheet@${gone}` };
  }

  if (removed.length) return { type: "listen", reason: "idle", id: removed[0].id };
  return null;
}

/**
 * Holds back an edit that would take a listen widget, a whiteboard or a spreadsheet out of the note, however it's taken out:
 * Backspace, Delete, Enter or typing while it's selected, pasting or cutting over it, its remove button, an undo.
 * `onBlocked` is given the edit, to ask first, and dispatch it again with WIDGET_REMOVAL_CONFIRMED set if it should go
 * ahead. `activeWidget` is the id of the listen widget recording or being transcribed, if any.
 */
export const WidgetRemovalGuard = Extension.create<{
  activeWidget: () => string | null;
  onBlocked: (tr: Transaction, removal: WidgetRemoval) => void;
}>({
  name: "widgetRemovalGuard",

  addOptions() {
    return { activeWidget: () => null, onBlocked: () => {} };
  },

  addProseMirrorPlugins() {
    const { activeWidget, onBlocked } = this.options;
    return [
      new Plugin({
        key: new PluginKey("widgetRemovalGuard"),
        filterTransaction: (tr) => {
          if (!tr.docChanged || tr.getMeta(WIDGET_REMOVAL_CONFIRMED)) return true;
          const removal = widgetRemoval(tr, activeWidget());
          if (!removal) return true;
          onBlocked(tr, removal);
          return false;
        },
      }),
    ];
  },
});
