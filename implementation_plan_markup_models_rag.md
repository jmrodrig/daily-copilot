# Implementation Plan: Right-Click Eraser, Gemini Models & Local Folder RAG

## Branch
Continue on branch `feat/local-files`.

---

## 1. Part A: Right-Click Eraser Toggle (Markup & Whiteboard)

### Target Files:
- `desktop/src/components/WhiteboardView.tsx`
- `desktop/src/components/MediaLightbox.tsx`

### Requirements:
1. **Remove Shift Key Toggle**:
   - Remove the `keydown`/`keyup` listeners that swap the active tool with the eraser when Shift is held.
2. **Right-Click Eraser Toggle**:
   - Intercept `contextmenu` on the canvas/stage container and `preventDefault()` so the browser's right-click menu does not appear.
   - On right-click (e.g. `onContextMenu` or pointer down with `e.button === 2`):
     - If the current tool is an eraser (`isEraser(tool)`):
       - Switch back to the previous tool (defaulting to `"draw"` if unknown).
     - If the current tool is NOT an eraser:
       - Save the current tool to a ref (e.g. `previousToolRef.current = tool`).
       - Switch to the active eraser tool (`eraserRef.current`).
   - If right-click dragging occurs:
     - Ensure right-click drag operates the eraser smoothly just like standard left-click erase.

---

## 2. Part B: All Gemini API Models & Remember Selection

### Target Files:
- `backend/main.py`
- `backend/schemas.py`
- `backend/agent.py`
- `desktop/src/components/CopilotChat.tsx`

### Requirements:
1. **Backend Model Discovery (`GET /api/models`)**:
   - Create endpoint `GET /api/models`.
   - Query Google Gemini API using `litellm` or `https://generativelanguage.googleapis.com/v1beta/models?key={gemini_api_key}` with `settings.gemini_api_key.get_secret_value()`.
   - Return list of model names (e.g., `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-1.5-pro`, `gemini-1.5-flash`, `gemini-3.1-pro-preview`).
   - Include sensible static fallback list of standard Gemini models if the API call fails or key is missing.
2. **Chat Request Model Support (`backend/schemas.py` & `backend/agent.py`)**:
   - In `ChatRequest`, add `model: str | None = None`.
   - In `agent.run_chat`, accept `model: str | None = None`.
   - If provided, prefix with `gemini/` if needed and pass to `litellm.completion(model=chosen_model, ...)` instead of hardcoded `settings.chat_model`.
3. **Frontend Selection & Persistence (`desktop/src/components/CopilotChat.tsx`)**:
   - Fetch available models from `GET /api/models`.
   - Load previously selected model from `localStorage.getItem("copilot_chat_model")` (fallback to backend default from `/health`).
   - Replace the static model badge with a clean dropdown / picker (using standard button/select or Popover).
   - When user picks a model, save it to `localStorage.setItem("copilot_chat_model", selectedModel)`.
   - Pass the selected model in the payload to `POST /api/chat`.

---

## 3. Part C: Local Folders for RAG Specified in Preferences

### Target Files:
- `backend/models.py`
- `backend/schemas.py`
- `backend/spaces.py`
- `backend/agent.py`
- `desktop/src/lib/space.tsx`
- `desktop/src/pages/SpacePreferences.tsx`

### Requirements:
1. **Database & Schema**:
   - In `backend/models.py`, add to `Space`:
     ```python
     rag_folders: Mapped[list[str] | None] = mapped_column(JSON, default=list)
     ```
   - In `backend/schemas.py`:
     - Add `rag_folders: list[str] = Field(default_factory=list)` to `Space`.
     - Add `rag_folders: list[str] | None = None` to `SpaceUpdate`.
   - In `backend/spaces.py`:
     - Pass through `rag_folders` when updating space in `update_space` / `put_space`.
2. **Agent RAG Ingestion (`backend/agent.py`)**:
   - In `space_context(space_id, note_path)`:
     - Retrieve `space.rag_folders` from the active space.
     - For each folder, check existence and list available files (capping at a safe budget, e.g. top files/subfolders).
     - Inject into system prompt:
       ```
       Configured Local RAG Folders for this space:
       - {folder}: [{files...}]
       Always search and read from these folders using list_local_directory and read_local_file when answering questions about design data, specifications, vessels, and engineering files.
       ```
3. **Frontend Preferences UI (`desktop/src/pages/SpacePreferences.tsx`)**:
   - Add a new section **"RAG Local Folders"** to `SpacePreferences.tsx`.
   - Display currently configured folders with a "Remove" button.
   - Text input + "Add folder" button to add a local path (e.g. `O:\Lawrences Files`, `Y:\Shared`).
   - Validate with `checkLocalFile` before adding (show error if path does not exist).
   - Save changes via `updateSpace(space.id, { rag_folders: ... })`.
   - Update `desktop/src/lib/space.tsx` types to include `rag_folders?: string[]`.

---

## 4. Verification & Testing
1. Run backend tests: `pytest backend/tests/`
2. Run frontend typecheck: `npm run typecheck`
3. Verify right-click on whiteboard/lightbox toggles between pen and eraser without showing context menu.
4. Verify `/api/models` lists Gemini models and chat uses the selected model.
5. Verify adding a folder in Space Preferences persists and is reflected in the agent's RAG context.
