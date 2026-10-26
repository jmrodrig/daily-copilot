import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { errorDetail, getJson } from "./api";
import type { ProjectOption, StatusFlow } from "./tasks";

export type CustomFieldType = "text" | "number" | "date" | "checkbox" | "dropdown" | "person";

/**
 * One custom task field of a space; tasks keep its value under `id` (see CustomFieldDef in backend/schemas.py).
 * `options` are a dropdown's choices, in order, and `colors` maps some of them to a "#rrggbb" colour; both are
 * empty for the other types. `show_inline` puts the field on the inline task creation card.
 */
export type CustomFieldDef = {
  id: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  colors: Record<string, string>;
  show_inline?: boolean;
};

// GET /api/spaces (see Space in backend/schemas.py). `status_colors` holds the statuses whose colour the space changed
// (see DEFAULT_STATUS_COLORS for the rest); `rag_folders` the local folders the Co-pilot searches for the space's data.
export type Space = {
  id: number;
  name: string;
  status_flow: StatusFlow | null;
  custom_fields_schema: CustomFieldDef[];
  status_colors: Record<string, string>;
  rag_folders?: string[];
};

/**
 * Body of `PUT /api/spaces/{id}`: fields left out are kept. With `custom_fields_schema`, `renamed_options` (field id ->
 * old dropdown option -> new name) moves tasks holding a renamed option over to its new name.
 */
export type SpaceUpdate = Partial<Pick<Space, "name" | "status_flow" | "custom_fields_schema">> & {
  renamed_options?: Record<string, Record<string, string>>;
  status_colors?: Record<string, string>;
  rag_folders?: string[];
};

type SpaceState = {
  spaces: Space[];
  /** The active space: the sidebar, task views and Co-pilot only see this space. */
  spaceId: number;
  space: Space | undefined;
  /** The active space's projects (reloaded with the tree), e.g. for their colours in the sidebar. */
  projects: ProjectOption[];
  setSpaceId: (id: number) => void;
  createSpace: (name: string) => Promise<Space>;
  /** Rename a space and/or change its task preferences. */
  updateSpace: (id: number, changes: SpaceUpdate) => Promise<Space>;
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
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    getJson<Space[]>("/api/spaces", controller.signal)
      .then(setSpaces)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Marking a folder as Project or recolouring one refreshes the tree, so reload with it.
  useEffect(() => {
    const controller = new AbortController();
    getJson<ProjectOption[]>(`/api/projects?space_id=${spaceId}`, controller.signal)
      .then(setProjects)
      .catch(() => {});
    return () => controller.abort();
  }, [spaceId, treeVersion]);

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

  const updateSpace = useCallback(async (id: number, changes: SpaceUpdate) => {
    const res = await fetch(`/api/spaces/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    const space: Space = await res.json();
    setSpaces((prev) => prev.map((s) => (s.id === space.id ? space : s)));
    return space;
  }, []);

  const refreshTree = useCallback(() => setTreeVersion((v) => v + 1), []);

  const value = useMemo(
    () => ({
      spaces,
      spaceId,
      space: spaces.find((s) => s.id === spaceId),
      projects,
      setSpaceId,
      createSpace,
      updateSpace,
      treeVersion,
      refreshTree,
    }),
    [spaces, spaceId, projects, setSpaceId, createSpace, updateSpace, treeVersion, refreshTree],
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

/** Opens a note (or template) in a new browser window or tab, e.g. to read it beside another. */
export function openNoteInNewWindow(spaceId: number, path: string, root: "content" | "templates" = "content") {
  window.open(`${window.location.origin}${notePath(spaceId, path, root)}`, "_blank", "noopener,noreferrer");
}
