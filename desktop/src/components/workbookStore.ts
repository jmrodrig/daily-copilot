/**
 * Workbook files attached to notes (`/api/notes/image/<name>.xlsx?space_id=1`), as spreadsheets being edited: one copy
 * of each, by its link, shared by everything showing it (its windows in the note, its full view), so an edit in one
 * shows in the others at once. Each edit is written back to the file, a moment after the last one (`SAVE_DELAY_MS`).
 *
 * A file is read when something starts showing it, and again when the app gets the focus back (it may have been
 * edited in Excel meanwhile), unless an edit is waiting to be saved. A workbook too big to read whole
 * (`IMPORT_MAX_ROWS` × `IMPORT_MAX_COLS`) is shown, but never saved: that would cut it.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { errorDetail, message } from "../lib/api";
import { openLocalFile, isLocalHref } from "../lib/localFiles";
import { parseWorkbookBuffer, workbookFormatOf, writeWorkbookBuffer, type SpreadsheetData } from "./spreadsheet";

const SAVE_DELAY_MS = 800;

export type WorkbookState = {
  data: SpreadsheetData | null;
  /** Why it couldn't be read. */
  error: string | null;
  /** Why the last save failed. */
  saveError: string | null;
  saving: boolean;
  /** Read only: too big to be saved without cutting it. */
  truncated: boolean;
};

type Entry = {
  state: WorkbookState;
  listeners: Set<() => void>;
  /** Edited and not yet saved. */
  dirty: boolean;
  timer: number | null;
  loading: Promise<void> | null;
  saving: Promise<void> | null;
};

const EMPTY: WorkbookState = { data: null, error: null, saveError: null, saving: false, truncated: false };
const entries = new Map<string, Entry>();

function entryOf(src: string): Entry {
  let entry = entries.get(src);
  if (!entry) {
    entry = { state: EMPTY, listeners: new Set(), dirty: false, timer: null, loading: null, saving: null };
    entries.set(src, entry);
  }
  return entry;
}

function setState(entry: Entry, change: Partial<WorkbookState>) {
  entry.state = { ...entry.state, ...change };
  for (const listener of entry.listeners) listener();
}

/** Whether a link is to a file attached to a note (stored in the space), which the app can read and save. */
export function isAttachmentHref(href: string | null | undefined): href is string {
  return !!href && href.includes("/api/notes/image/");
}

/** A file name for a link: the label it's shown with, else the end of its path. */
export function workbookTitle(src: string, label?: string | null): string {
  if (label?.trim()) return label.trim();
  return decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() ?? "Spreadsheet");
}

function load(src: string): Promise<void> {
  const entry = entryOf(src);
  if (entry.loading) return entry.loading;
  entry.loading = (async () => {
    try {
      const res = await fetch(src, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorDetail(res));
      const { data, truncated } = await parseWorkbookBuffer(await res.arrayBuffer());
      // An edit made while it was read wins.
      if (!entry.dirty) setState(entry, { data, truncated, error: null });
    } catch (err) {
      if (!entry.state.data) setState(entry, { error: message(err) });
    } finally {
      entry.loading = null;
    }
  })();
  return entry.loading;
}

async function save(src: string): Promise<void> {
  const entry = entryOf(src);
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }
  // One save at a time: the next one takes what's newest when it goes.
  if (entry.saving) await entry.saving;
  if (!entry.dirty || !entry.state.data) return;
  const data = entry.state.data;
  entry.dirty = false;
  setState(entry, { saving: true });
  entry.saving = (async () => {
    try {
      const body = await writeWorkbookBuffer(data, workbookFormatOf(src));
      const res = await fetch(src, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body });
      if (!res.ok) throw new Error(await errorDetail(res));
      setState(entry, { saving: false, saveError: null });
    } catch (err) {
      // Kept to try again with the next edit, or when the full view closes.
      if (entry.state.data === data) entry.dirty = true;
      setState(entry, { saving: false, saveError: message(err) });
    } finally {
      entry.saving = null;
    }
  })();
  await entry.saving;
}

/** Save any edit to the file at `src` still waiting for its moment. */
export function flushWorkbook(src: string): Promise<void> {
  const entry = entries.get(src);
  return entry?.dirty ? save(src) : Promise.resolve();
}

/** Change the workbook at `src`: shown everywhere at once, and saved to its file shortly. */
export function updateWorkbook(src: string, data: SpreadsheetData) {
  const entry = entryOf(src);
  if (entry.state.truncated) return;
  entry.dirty = true;
  setState(entry, { data });
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => void save(src), SAVE_DELAY_MS);
}

// Back in the app (from Excel, say): files shown, and not being edited, are read again.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const [src, entry] of entries) if (entry.listeners.size && !entry.dirty && !entry.saving) void load(src);
  });
  window.addEventListener("beforeunload", () => {
    for (const [src, entry] of entries) if (entry.dirty) void save(src);
  });
}

/** The workbook at `src` (null for none), read when first shown, and kept up to date with its edits. */
export function useWorkbook(src: string | null): WorkbookState {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!src) return () => {};
      const entry = entryOf(src);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [src],
  );
  const state = useSyncExternalStore(subscribe, () => (src ? entryOf(src).state : EMPTY));
  useEffect(() => {
    if (!src) return;
    const entry = entryOf(src);
    // Read afresh when shown, unless it holds an edit not yet saved.
    if (!entry.dirty && !entry.saving) void load(src);
  }, [src]);
  return state;
}

/**
 * Open a spreadsheet in its program on this machine (Excel, say): a file attached to a note through the backend, a
 * linked local file as local files open (see openLocalFile).
 */
export async function openInNativeApp(src: string): Promise<void> {
  const local: boolean = isLocalHref(src);
  if (local) return openLocalFile(src);
  await flushWorkbook(src);
  const [path, query] = src.split("?");
  try {
    const res = await fetch(`${path}/open${query ? `?${query}` : ""}`, { method: "POST" });
    if (!res.ok) throw new Error(await errorDetail(res));
  } catch (err) {
    window.alert(`Could not open the spreadsheet (${message(err)}).`);
  }
}

/** POST /api/notes/spreadsheet/new: a blank workbook attached to the space, with its link and file name. */
export async function createWorkbook(spaceId: number, title = "Spreadsheet.xlsx"): Promise<{ url: string; title: string }> {
  const res = await fetch("/api/notes/spreadsheet/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space_id: spaceId, title }),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  const body = (await res.json()) as { url: string; title: string };
  return { url: body.url, title: body.title };
}
