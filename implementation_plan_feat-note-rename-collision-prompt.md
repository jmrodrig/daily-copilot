# Implementation Plan: Note Rename Collision Gate & User Prompt

**Task ID**: `feat-note-rename-collision-prompt`  
**Git Branch**: `feat-note-rename-collision-prompt`  
**Target Plan Filename**: `implementation_plan_feat-note-rename-collision-prompt.md`  

---

## 1. Problem Statement & Motivation

Currently, when a user renames a note (by editing its title in the editor or sidebar) to a name that already exists in the same folder, the backend automatically appends a number suffix (e.g. `(2)`, `(3)`).  
The user wants to **gate collisions** instead of automatically appending differentiating numbers:
- When a name collision occurs within the folder, the backend must throw an HTTP 409 Conflict error.
- The UI must gate the action and prompt the user to pick a different name (or revert/cancel).

---

## 2. Technical Architecture & Changes

### Component A: Backend Collision Detection (`backend/main.py`)

1. **`update_note` (`PUT /api/notes/file`)**:
   - In `backend/main.py`, replace the automatic collision loop in `_unique_note_path`:
     ```python
     if request.title is not None:
         stem = sanitize_note_filename(request.title, fallback=Path(path).stem)
         target = _sibling(path, f"{stem}{file_layer.NOTE_SUFFIX}")
         if target.lower() != path.lower() and (root / target).exists():
             raise HTTPException(
                 status_code=409,
                 detail=f"A note named '{stem}' already exists in this folder. Please choose a different name.",
             )
         if target != path:
             path = _move_entry(db, request.space_id, root, ContentEntry(kind=ContentKind.NOTE, path=path), target).path
     ```
   - Clean up or remove `_unique_note_path` since it was only called by `update_note`.
2. **`rename_content` (`POST /api/content/rename`) & `_move_entry`**:
   - Ensure `_move_entry` or `rename_content` formats the 409 Conflict exception cleanly:
     `HTTPException(status_code=409, detail=f"A note named '{clean_stem}' already exists in this folder. Please choose a different name.")`

### Component B: Frontend Collision Prompt Modal (`desktop/src/pages/NotePage.tsx`)

1. **Collision State in `NotePage.tsx`**:
   - Add state for collision dialog:
     ```ts
     const [collision, setCollision] = useState<{ conflictingTitle: string; draft: string } | null>(null);
     ```
2. **Handle 409 in `save()`**:
   - When `save()` catches an error:
     ```ts
     } catch (err: unknown) {
       const msg = message(err);
       failedRef.current = `${draft}\n${content}`;
       setSaveError(msg);
       if (msg.toLowerCase().includes("already exists")) {
         setCollision({ conflictingTitle: draft.trim(), draft: draft.trim() });
       }
     }
     ```
3. **Collision Prompt Modal Dialog**:
   - Render a modal dialog when `collision` is non-null:
     - Backdrop: `fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]`
     - Panel styling matching the app's `NewItemDialog` / `panel flex w-[420px] flex-col gap-3`.
     - Heading: "Name already taken"
     - Description: `A note named "${collision.conflictingTitle}" already exists in this folder. Please choose a different name.`
     - Input field (autofocus, `className="field"`): allows user to type a new name.
     - Actions:
       - "Cancel / Revert": reverts `titleDraft` back to the saved note title (`noteTitle(note.note.frontmatter, note.note.path)`), clears `saveError`, and closes the modal (`setCollision(null)`).
       - "Rename": sets `titleDraft` to the new name, closes the modal (`setCollision(null)`), and immediately invokes `save()`.
     - Keyboard support: Enter triggers Rename; Escape triggers Cancel/Revert.

### Component C: Sidebar Rename Collision Handling (`desktop/src/components/Sidebar.tsx`)

1. **Prompt on Sidebar Collision**:
   - In `renameItem(item: TreeItem, name: string)`:
     If `changeContent` fails due to an "already exists" error:
     Prompt the user using `window.prompt`:
     ```ts
     const nextName = window.prompt(
       `A note named "${clean}" already exists in this folder. Please pick a different name:`,
       clean
     );
     if (nextName && nextName.trim() && nextName.trim() !== clean) {
       void renameItem(item, nextName.trim());
     }
     ```

---

## 3. Automated Testing Strategy

### Backend Tests (`backend/tests/test_api.py`)
1. **Update `test_update_note_resolves_collision_with_existing_file`**:
   - Rename to `test_update_note_throws_409_on_collision_with_existing_file`.
   - Setup: `Target.md` and `Other.md` in the same directory.
   - When calling `PUT /api/notes/file` on `Other.md` with `title: "Target"`:
     - Verify status code is `409`.
     - Verify response detail contains `"already exists in this folder. Please choose a different name"`.
     - Verify `Other.md` was NOT renamed on disk and still exists.
     - Verify `Target.md` remains untouched.
2. Run full pytest suite: `pytest backend/tests`.

### Frontend Typecheck & Build
1. Run `npm run typecheck` in `desktop`.
2. Run `npm run build` in `desktop`.
3. Run `npx playwright test tests/kanban-sort.spec.ts` in `desktop`.

---

## 4. User-Driven Manual Verification Steps (Strictly Enforced)

1. **Launch App**:
   Ensure development servers are running (`uvicorn` on 8000, `vite` on 5173).
2. **Test Note Editor Collision Gate**:
   - In your space's root folder (or any subfolder), create a note named `Alpha`.
   - Create a second note named `Beta`.
   - Open note `Beta`.
   - In the title header at the top, change the title to `Alpha` and press Enter (or blur).
   - **Verify Collision Modal**: A modal prompt appears stating:
     `A note named "Alpha" already exists in this folder. Please choose a different name.`
   - Type `Beta Revised` into the modal input and click **Rename** (or press Enter).
   - **Verify Success**: The modal closes, note `Beta` is renamed to `Beta Revised.md` on disk, and the URL updates to `Beta%20Revised.md`.
   - Test **Cancel/Revert**: Change the title to `Alpha` again. When the collision modal appears, click **Revert to original** (or press Escape). Verify `titleDraft` reverts to `Beta Revised` and the file on disk remains `Beta Revised.md`.
3. **Test Sidebar Rename Collision Gate**:
   - Right-click `Beta Revised` in the sidebar and click **Rename**.
   - Type `Alpha` and press Enter.
   - **Verify Prompt**: A prompt alerts you that `Alpha` already exists in this folder and asks for a different name.
   - Provide a different name (e.g. `Beta Final`) &mdash; verify it renames cleanly to `Beta Final.md`.
