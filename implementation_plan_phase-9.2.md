# Implementation Plan: Phase 9.2 - Sidebar UX & Drag-and-Drop
**Task ID:** phase-9.2

## Goal
Refine the sidebar Content tree to fully support Confluence-style organization. Implement drag-and-drop for moving notes/folders, add hover-revealed action menus (`+` and `...`) to all items, and clean up legacy hardcoded links.

## Scope
### 1. Clean Up Legacy Links
- Open `desktop/src/components/Sidebar.tsx`.
- Remove the hardcoded "Tasks" item that is currently being injected inside folders marked as projects. The Content tree should purely reflect the file system + FolderMeta markers, with no phantom routes.

### 2. Hover Actions (`+` and `...`)
- Update the tree rendering logic so that hovering over any item (folder or note) reveals action icons aligned to the right.
- **`+` Icon (Folders Only):**
  - Clicking `+` opens a dropdown menu to create items *inside* that folder.
  - Options: "New Folder", "New Note", and dynamically list the available templates from the `templates/` directory (e.g., "From template: Meeting note").
  - Triggers the existing new folder / new note endpoints, passing the chosen template if applicable.
- **`...` Icon (Folders & Notes):**
  - Options: "Rename", "Duplicate", "Delete".
  - **Rename:** Turns the tree item into an inline text input (or opens a small dialog) to rename the file/folder.
  - **Duplicate:** Creates a copy (e.g., `filename (copy).md`).
  - **Delete:** Triggers a deletion confirmation, then deletes the file/folder.

### 3. Drag-and-Drop Reorganization
- Make all tree items draggable.
- Make all folders valid drop targets.
- When a note or folder is dropped onto a folder, it should move the item to the new path.
- **Backend API (`backend/main.py`):**
  - Ensure there is a robust `POST /api/notes/move` (or similar) endpoint that handles moving files and directories, updating `FolderMeta` if a directory is moved, and recording the move in the history.
  - Ensure there are endpoints for renaming and duplicating.

## Execution Order
1. Build backend endpoints for Move, Rename, Duplicate, and Delete if they are missing or incomplete.
2. Clean up `Sidebar.tsx` to remove the legacy `Tasks` injection.
3. Implement the `+` and `...` hover state and their corresponding menus in `Sidebar.tsx`.
4. Implement HTML5 Drag and Drop (or a lightweight dnd library if already in `package.json`) on the tree nodes to hit the `move` endpoint.
