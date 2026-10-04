# Implementation Plan: Phase 9.3 - Note States & Folder Constraints
**Task ID:** phase-9.3

## Goal
Introduce a Draft/Published state toggle for markdown notes (managing frontmatter and editability) and restrict the "Mark as Project" and "Mark as Reference" designations to top-level folders only.

## Scope
### 1. Folder Constraints (Projects & Reference Data)
- **Frontend (`desktop/src/components/Sidebar.tsx`):**
  - Update the `...` context menu logic.
  - The options "Mark as Project" and "Mark as Reference Data" (and their "Unmark" equivalents) should *only* be rendered if the folder is at the root level of the `content/` directory (i.e., it has no parent folder / path has no slashes).
- **Backend (`backend/spaces.py` / `main.py`):**
  - Add validation to the endpoints that toggle `is_project` and `is_reference`. If the requested folder path contains a directory separator (meaning it is a subfolder), return a 400 Bad Request.

### 2. Note States (Draft vs. Published)
- **Data Model:** Store the state in the markdown note's frontmatter as `state: draft` or `state: published`. If missing, default to `published` for backward compatibility with existing notes, or `draft` for newly created ones.
- **Frontend (`desktop/src/pages/NotePage.tsx`):**
  - Parse the `state` from the frontmatter.
  - **Header UI:** 
    - Display a pill/badge next to the note title showing `DRAFT` or `PUBLISHED`.
    - Display a primary action button on the top right: `PUBLISH` (if draft) or `EDIT` (if published).
  - **Body UI:**
    - If `state === 'draft'`, render a full-width, auto-resizing `<textarea>` allowing the user to edit the raw markdown (including frontmatter, or just the body if frontmatter is managed via state). *Decision:* Simplest is to edit the raw text, but ideally, we should provide a clean text editor for the body and handle the frontmatter behind the scenes.
    - If `state === 'published'`, render the existing `react-markdown` viewer. The note is non-editable in this state.
- **Backend API:**
  - Update `PUT /api/notes/file` (or create a specific toggle endpoint) to update the note content and its frontmatter state when the user clicks the toggle button or saves their draft.

## Execution Order
1. Apply the top-level folder constraints to the backend API.
2. Apply the top-level folder constraints to the `Sidebar.tsx` context menu.
3. Update `NotePage.tsx` to handle the frontmatter `state`, rendering the Draft/Published badge and toggle button.
4. Implement the editable textarea view for the Draft state.
5. Wire up the save/publish actions to the backend.
