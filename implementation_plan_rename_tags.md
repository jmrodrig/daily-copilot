# Implementation Plan: Update Project Tag with Name

## Goal
When a user updates a project's name via Space Preferences, automatically update the project's `code` (which acts as its tag) to match the new name, and rename the old tag across all tasks and markdown notes.

## Branch
Use branch `feat/update-project-tags`

## 1. Backend: Modify `update_project`
**File:** `backend/main.py`
- In `update_project`, before updating the project fields, check if `request.name` is provided and differs from `project.name`.
- If it differs, generate `new_code = request.name[:spaces._CODE_MAX]`. (Import `spaces` if needed).
- If `new_code != project.code`:
  - Check for collisions: query if any other project has this code (case-insensitively). If so, raise `HTTPException(400, "Project code already in use")`.
  - Store `old_code = project.code`.
  - Update `project.code = new_code`.
  - **Migrate Tasks:**
    - Query all tasks that have tags (`select(Task).where(Task.tags.is_not(None))`).
    - For each task, check if `old_code` (case-insensitively) exists in its `tags` array.
    - If it does, replace it with `new_code`, and assign it back to `task.tags`.
  - **Migrate Notes:**
    - Iterate over all spaces in the database (`db.scalars(select(Space)).all()`).
    - For each space, get `root = spaces.content_dir(space.id)`.
    - If `root` exists, iterate over `file_layer.list_notes("**/*.md", notes_dir=root)`.
    - Skip hidden files (`_hidden(path)`).
    - Use `file_layer.read_note(path, notes_dir=root)` to read the note.
    - If `old_code` is found in the `tags` array within `frontmatter` (case-insensitively), replace it with `new_code`.
    - Call `file_layer.write_note(path, note_data["content"], fm, access_mode=file_layer.AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)`.
- Update the docstring to remove the warning about the code being fixed.

## 2. Testing
- Verify that `pytest backend/tests` passes.
- No frontend changes needed since the frontend just sends `PUT /api/projects/{id}` with the new name, and it will receive the updated project with the new code.
