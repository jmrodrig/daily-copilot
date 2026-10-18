# Implementation Plan: Note Renaming Filename Sync & Kanban Due Date Ordering

**Task ID**: `feat-note-rename-filename-and-kanban-due-date-sort`  
**Git Branch**: `feat-note-rename-filename-and-kanban-due-date-sort`  
**Target Plan Filename**: `implementation_plan_feat-note-rename-filename-and-kanban-due-date-sort.md`  

---

## 1. Problem Statements & Overview

### Bug 1: Note Renaming Does Not Update Note Filename On Disk
- **Issue**: When a user renames a note by editing its title at the top of the Note Editor (`NotePage.tsx`), `PUT /api/notes/file` only updates `frontmatter["title"] = request.title`. The underlying `.md` file on disk retains its original filename (e.g. `Untitled.md` or `new-note.md`) forever.
- Furthermore, in the Sidebar context menu rename (`Sidebar.tsx`), if a note's frontmatter title is already "My Note" while its file on disk is `Untitled.md`, attempting to rename to "My Note" is treated as a no-op because `clean === itemLabel(item)`, leaving the file on disk unsynchronized.
- Filenames also need safe sanitization across platforms (Windows / macOS / Linux) to strip or replace illegal characters (`< > : " / \ | ? *`, control characters, trailing dots/spaces) and resolve name collisions gracefully without crashes or data loss.

### Bug 2: Kanban Task Ordering Does Not Sort By Due Date
- **Issue**: In `desktop/src/pages/Tasks.tsx`, the Kanban board columns sort tasks solely by priority:
  ```ts
  .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
  ```
  Tasks sharing the same priority level retain arbitrary order (whatever order they arrived from the server or were inserted in the client).
- **Requirement**: Tasks sharing the same priority MUST be ordered by due date (earliest / sooner due date first; tasks with a due date placed ahead of tasks with no due date).

---

## 2. Proposed Changes & Technical Architecture

### Component A: Filename Sanitization & Sibling Resolution (`backend/main.py`)

1. **Filename Sanitizer**:
   Add `sanitize_note_filename(title: str, fallback: str = "Untitled") -> str`:
   - Replace illegal characters `< > : " / \ | ? *` and ascii control chars (`\x00-\x1f`) with `-`.
   - Normalize whitespace (newlines, tabs, multiple spaces collapsed).
   - Collapse multiple consecutive hyphens (`--` -> `-`).
   - Strip leading and trailing whitespace, dots, and hyphens (`.strip(". -")`), because Windows strictly disallows filenames ending in a dot or space.
   - If the resulting string is empty, fall back to `fallback`.

2. **Unique Sibling Path Helper**:
   Add `_unique_note_path(root: Path, current_path: str, new_stem: str) -> str`:
   - Forms target path: `_sibling(current_path, f"{new_stem}{file_layer.NOTE_SUFFIX}")`.
   - If target path equals `current_path`, returns `current_path` (no rename).
   - If `(root / target_path).exists()`, searches for `_sibling(current_path, f"{new_stem} ({n}){file_layer.NOTE_SUFFIX}")` where `n = 2, 3, ...` until an unused path is found.

3. **`PUT /api/notes/file` (`update_note` in `backend/main.py`)**:
   - When `request.title` is provided:
     - Set `frontmatter["title"] = request.title`.
     - Compute `target_stem = sanitize_note_filename(request.title, fallback=Path(note["path"]).stem)`.
     - Compute `target_path = _unique_note_path(root, note["path"], target_stem)`.
     - If `target_path != note["path"]`:
       - Relocate using `_move_entry(db, request.space_id, root, ContentEntry(kind=ContentKind.NOTE, path=note["path"]), target_path)`.
         *(Note: `_move_entry` executes `file_layer.rename_note` which records the rename history with `previous_path`, and executes `spaces.relocate` which updates all linked tasks in the database).*
       - Write the note's new content and frontmatter to `target_path`.
       - Return `NoteFile(path=target_path, frontmatter=to_jsonable(frontmatter), content=content)`.
     - Else:
       - Write content and frontmatter to `note["path"]`.
       - Return `NoteFile(path=note["path"], frontmatter=to_jsonable(frontmatter), content=content)`.

4. **`POST /api/content/rename` (`rename_content` in `backend/main.py`)**:
   - Sanitize `request.name`:
     ```python
     raw_stem = request.name.removesuffix(file_layer.NOTE_SUFFIX)
     clean_stem = sanitize_note_filename(raw_stem, fallback=raw_stem or "Untitled")
     name = f"{clean_stem}{file_layer.NOTE_SUFFIX}"
     ```

### Component B: Frontend Note Editor Navigation Sync (`desktop/src/pages/NotePage.tsx`)

1. **Follow Path Relocation**:
   In `NotePage.tsx`:
   - In `save()`:
     ```ts
     const currentPath = path;
     const saved = await sendJson<NoteFile>("PUT", "/api/notes/file", ...);
     setNote({ state: "ok", note: saved });
     setExternalChange(false);
     setBody((current) => (current === content ? saved.content : current));
     setTitleDraft((current) => (current === draft ? noteTitle(saved.frontmatter, saved.path) : current));
     refreshTree();

     if (saved.path !== currentPath) {
       unsavedRef.current = null;
       navigate(notePath(spaceId, saved.path, isTemplate ? "templates" : undefined), { replace: true });
       notifyNoteUpdated(spaceId, saved.path);
       notifyNoteUpdated(spaceId, currentPath);
     }
     ```
   - Clearing `unsavedRef.current = null` before calling `navigate(...)` ensures the cleanup unmount effect doesn't issue a redundant save to the old path.
   - Replacing the route URL smoothly updates the browser address bar to `/note?space=<id>&path=<new_path>` without disrupting user typing or adding extra history entries.

### Component C: Sidebar Rename Fix (`desktop/src/components/Sidebar.tsx`)

1. **Allow Rename if Stem Differs**:
   In `Sidebar.tsx`:
   - In `renameItem(item: TreeItem, name: string)`:
     ```ts
     const itemStem = item.kind === "note" ? item.note.path.split("/").pop()?.replace(/\.md$/i, "") : item.folder.name;
     if (!clean || (clean === itemLabel(item) && clean === itemStem)) return;
     ```
     This allows renaming a note whose title was changed or whose filename is out of sync with its title.

### Component D: Kanban Due Date Ordering (`desktop/src/lib/tasks.ts` & `desktop/src/pages/Tasks.tsx`)

1. **Kanban Task Comparator (`desktop/src/lib/tasks.ts`)**:
   Export a clear, well-tested comparator:
   ```ts
   /**
    * Sort comparator for Kanban cards:
    * 1. Priority rank: most pressing first (urgent -> high -> normal -> low).
    * 2. Due date (deadline): earliest / sooner due date first; tasks without a due date placed last.
    * 3. Tie-breaker: task ID ascending.
    */
   export function compareKanbanTasks(a: TaskItem, b: TaskItem): number {
     const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
     if (priorityDiff !== 0) return priorityDiff;

     const dueA = a.deadline ?? "9999-99-99";
     const dueB = b.deadline ?? "9999-99-99";
     const dueDiff = dueA.localeCompare(dueB);
     if (dueDiff !== 0) return dueDiff;

     return a.id - b.id;
   }
   ```

2. **Apply in `Kanban` (`desktop/src/pages/Tasks.tsx`)**:
   Import `compareKanbanTasks` and update column card sorting:
   ```tsx
   const column = tasks
     .filter((t) => boardColumn(t.status) === status)
     .sort(compareKanbanTasks);
   ```

---

## 3. Automated Testing Strategy

### Backend Tests (`backend/tests/test_api.py`)
1. **`test_update_note_renames_file_on_disk_when_title_changes`**:
   - Create a note with `POST /api/notes` (`path: "Initial.md"`, `title: "Initial"`).
   - Call `PUT /api/notes/file` with `path: "Initial.md"` and `title: "Updated Title"`.
   - Verify response has `path == "Updated Title.md"`.
   - Verify `Initial.md` no longer exists on disk in `content_dir`.
   - Verify `Updated Title.md` exists and contains `title: Updated Title`.
2. **`test_update_note_sanitizes_filename_with_illegal_characters`**:
   - Call `PUT /api/notes/file` with `title: "Project: Phase 1 / Scantlings?"`.
   - Verify file is renamed to a safe filename (e.g. `Project- Phase 1 - Scantlings.md`).
3. **`test_update_note_resolves_collision_with_existing_file`**:
   - Create `Target.md`.
   - Create another note `Other.md`.
   - Update `Other.md` title to `"Target"`.
   - Verify `Other.md` is renamed to `"Target (2).md"`.
4. **`test_update_note_relocates_linked_tasks_on_rename`**:
   - Link a task to `Initial.md`.
   - Rename note to `NewName`.
   - Verify task in database has updated `note_path == "NewName.md"`.

### Frontend Tests (`desktop/src/lib/tasks.test.ts` or Playwright)
1. Unit test `compareKanbanTasks`:
   - Two tasks with different priorities: `urgent` sorts before `normal`.
   - Two tasks with same priority, both with due dates: `2026-10-19` sorts before `2026-10-25`.
   - Two tasks with same priority, one with due date, one without: task with due date sorts first.
   - Two tasks with same priority, neither with due date: sorts by `id`.
2. Run `npm run typecheck` and `npm run build`.

---

## 4. User-Driven Manual Verification Steps (Strictly Enforced)

Following the mandatory testing gate in `GEMINI.md`:

1. **Start Application**:
   Run `start.cmd` or launch backend (`uvicorn main:app --port 8000`) and frontend (`npm run dev` in `desktop/`).
2. **Verify Bug 1 (Note Renaming Filename Sync)**:
   - In the sidebar, create a new note named `Test Note`.
   - Open the note in the editor.
   - Click the title header input at the top and edit the title to `Final Scantlings Report`.
   - Press Enter or click into the note body.
   - **Check URL**: The URL in the address bar should update to `/note?space=1&path=Final%20Scantlings%20Report.md`.
   - **Check Sidebar**: The sidebar should show `Final Scantlings Report`.
   - **Check Filesystem**: Inspect the space's `content/` folder in Windows File Explorer. Confirm `Test Note.md` was renamed on disk to `Final Scantlings Report.md`.
   - **Check Special Characters**: Edit the title to `P5001: CE Checklist / Verification?`. Confirm file on disk is renamed safely without errors.
3. **Verify Bug 2 (Kanban Task Ordering by Due Date)**:
   - Navigate to the **Tasks** page -> **Kanban** view.
   - In the **To do** column, create three tasks with the **Normal** priority:
     - Task A: Due Date: `2026-10-30`
     - Task B: Due Date: `2026-10-20`
     - Task C: No Due Date
   - In the **To do** column, verify the visual card ordering from top to bottom:
     1. Task B (Due Oct 20 - sooner date first)
     2. Task A (Due Oct 30 - later date second)
     3. Task C (No due date - placed at the bottom of Normal priority)
   - Add an **Urgent** task with Due Date `2026-10-29`. Verify it appears at the very top of the column (priority takes precedence over normal priority), followed by Task B, Task A, and Task C.
