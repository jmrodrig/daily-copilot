import { useEffect, useRef } from "react";

export const NOTE_UPDATED_EVENT = "copilot:note-updated";

export type NoteUpdateDetail = {
  spaceId: number;
  path: string;
};

// Singleton broadcast channel instance if supported in browser/electron environment
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("copilot:notes") : null;

export function normalizeNotePath(p: string): string {
  return p.trim().replace(/^[\\/]+/, "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Notifies the current window and any other open windows (e.g. popout note windows)
 * that a note has been modified on disk.
 */
export function notifyNoteUpdated(spaceId: number, path: string) {
  if (!path) return;
  const detail: NoteUpdateDetail = { spaceId, path };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<NoteUpdateDetail>(NOTE_UPDATED_EVENT, { detail }));
  }
  try {
    channel?.postMessage(detail);
  } catch {
    // BroadcastChannel error ignored
  }
}

/**
 * Subscribes to updates for a specific note in a specific space.
 * When an update occurs for that note, `onUpdate` is called.
 */
export function useNoteUpdates(spaceId: number, path: string, onUpdate: () => void) {
  const latest = useRef(onUpdate);
  latest.current = onUpdate;

  useEffect(() => {
    if (!path) return;
    const targetNorm = normalizeNotePath(path);

    const matches = (detail: NoteUpdateDetail | null | undefined) => {
      if (!detail) return false;
      return detail.spaceId === spaceId && normalizeNotePath(detail.path) === targetNorm;
    };

    const handleLocal = (event: Event) => {
      const detail = (event as CustomEvent<NoteUpdateDetail>).detail;
      if (matches(detail)) {
        latest.current();
      }
    };

    const handleBroadcast = (event: MessageEvent<NoteUpdateDetail>) => {
      if (matches(event.data)) {
        latest.current();
      }
    };

    window.addEventListener(NOTE_UPDATED_EVENT, handleLocal);
    channel?.addEventListener("message", handleBroadcast);

    return () => {
      window.removeEventListener(NOTE_UPDATED_EVENT, handleLocal);
      channel?.removeEventListener("message", handleBroadcast);
    };
  }, [spaceId, path]);
}
