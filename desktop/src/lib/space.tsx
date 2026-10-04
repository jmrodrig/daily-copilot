import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { errorDetail, getJson } from "./api";

// GET /api/spaces (see Space in backend/schemas.py).
export type Space = { id: number; name: string };

type SpaceState = {
  spaces: Space[];
  /** The active space: the sidebar, task views and Co-pilot only see this space. */
  spaceId: number;
  space: Space | undefined;
  setSpaceId: (id: number) => void;
  createSpace: (name: string) => Promise<Space>;
  /** Bumped after the content tree changes (new note, folder flags), so views can reload. */
  treeVersion: number;
  refreshTree: () => void;
};

const SPACE_KEY = "copilot.space";
const DEFAULT_SPACE_ID = 1;

const SpaceContext = createContext<SpaceState | null>(null);

function storedSpaceId(): number {
  const value = Number(localStorage.getItem(SPACE_KEY));
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SPACE_ID;
}

export function SpaceProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceId, setSpaceIdState] = useState(storedSpaceId);
  const [treeVersion, setTreeVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getJson<Space[]>("/api/spaces", controller.signal)
      .then(setSpaces)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // A stored space that no longer exists falls back to the first one.
  useEffect(() => {
    if (spaces.length > 0 && !spaces.some((s) => s.id === spaceId)) setSpaceIdState(spaces[0].id);
  }, [spaces, spaceId]);

  const setSpaceId = useCallback((id: number) => {
    localStorage.setItem(SPACE_KEY, String(id));
    setSpaceIdState(id);
  }, []);

  const createSpace = useCallback(
    async (name: string) => {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      const space: Space = await res.json();
      setSpaces((prev) => [...prev, space]);
      setSpaceId(space.id);
      return space;
    },
    [setSpaceId],
  );

  const refreshTree = useCallback(() => setTreeVersion((v) => v + 1), []);

  const value = useMemo(
    () => ({
      spaces,
      spaceId,
      space: spaces.find((s) => s.id === spaceId),
      setSpaceId,
      createSpace,
      treeVersion,
      refreshTree,
    }),
    [spaces, spaceId, setSpaceId, createSpace, treeVersion, refreshTree],
  );
  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceState {
  const value = useContext(SpaceContext);
  if (!value) throw new Error("useSpace must be used inside <SpaceProvider>");
  return value;
}

/** Route of a note (or, with `root: "templates"`, a template) in a space. */
export function notePath(spaceId: number, path: string, root: "content" | "templates" = "content"): string {
  const params = new URLSearchParams({ space: String(spaceId), path });
  if (root === "templates") params.set("root", root);
  return `/note?${params}`;
}
