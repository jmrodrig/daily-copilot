# Implementation Plan: Content Tree Reordering

## Goal
Allow users to drag and drop items in the sidebar content tree to reorder them within the same folder (or root).

## Branch
Use branch `feat/sidebar-reorder`

## 1. Backend: Custom Order Storage
**Files:** `backend/schemas.py`, `backend/main.py`, `backend/spaces.py`
- Add `FolderOrderUpdate` to `schemas.py`: `space_id: int`, `path: str` (empty string for root), `order: list[str]`.
- Add `PUT /api/folders/order` to `main.py`: takes `FolderOrderUpdate`, resolves the folder path, and writes the `order` list as JSON to `.order.json` inside that directory.
- Modify `build_tree` in `spaces.py`:
  - When scanning a folder, look for `.order.json`.
  - If present and valid, parse it into a dict mapping `{filename: index}`.
  - Sort the `entries` list using `(order_dict.get(entry.name, float('inf')), entry.name.lower(), entry.name)` before appending them to `node.folders` and `node.notes`.

## 2. Frontend: Drag and Drop Logic
**File:** `desktop/src/components/Sidebar.tsx`
- Upgrade the `dropTarget` state. Instead of just a string (folder path), it should be `{ path: string, position: "before" | "after" | "inside" } | null`.
- Update `drag.over`:
  - Determine the bounding box of the hovered row.
  - If the hovered item is a folder, check if `clientY` is in the middle 50% (`inside`). If so, `position = "inside"`.
  - Otherwise, if `clientY < top + height / 2`, `position = "before"`, else `"after"`.
  - **Constraint:** If `parentOf(source) !== parentOf(hoveredItem)`, only allow `"inside"` (meaning they can move the item to the folder, but cross-folder precision reordering is skipped to keep it simple). If it's not a folder, disallow drop.
  - If `parentOf(source) === parentOf(hoveredItem)`, allow `"before"` and `"after"`.
- Update `TreeRow` styling to show a blue line indicator above or below the row when `position === "before"` or `"after"`.
- Update `drag.drop`:
  - If `position === "inside"`, call `moveItem`.
  - If `position === "before" | "after"`:
    - We need to gather the current names of all items in the parent folder to reorder them. You can fetch the parent `FolderNode` from the tree state or UI structure. A simple way is to traverse the local `tree` state to find the parent `FolderNode`, combine `folders` and `notes` into a single array of names, remove `sourceName`, and insert `sourceName` before/after `targetName`.
    - Call `sendJson("PUT", "/api/folders/order", { space_id: spaceId, path: parentFolder, order })`.
    - Then call `refreshTree()` to update the UI.
