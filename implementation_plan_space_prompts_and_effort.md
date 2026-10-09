# Implementation Plan: Space-Specific Prompts & Model Reasoning Effort

## Branch
Continue on branch `feat/local-files`.

---

## 1. Overview of Goals
1. **Space-Specific Saved Prompts (Slash Commands)**:
   - Make `SavedPrompt` belong to a specific `space_id`.
   - Move the Prompt Editor UI from `Settings.tsx` into `SpacePreferences.tsx`.
   - Remove `/settings` from the sidebar and redirect `/settings` to `/space-preferences`.
   - Seed default commands including:
     - `/prep`: "Draft a meeting prep brief"
     - `/design-search`: "Search the space's configured local folders using list_local_directory and read_local_file to answer the following..."
     - `/rcd`: "Find information in the RCD regulations in 'Y:\Classification, Certification & Documentation\RCD\All harmonized standards' using list_local_directory and read_local_file to answer the following..."
   - Update `_rag_block` in `agent.py`: Do not bloat the system prompt with 40 filenames on every query; keep it lightweight so the agent crawls when invoked via command or question.
2. **Model Reasoning Effort Selector**:
   - Add a Reasoning Effort selector (`Low`, `Medium`, `High`, `Auto`) next to the Model dropdown in the chat header.
   - Persist choice in `localStorage` under `copilot_reasoning_effort`.
   - Pass `reasoning_effort` in `POST /api/chat` and route to LiteLLM / Gemini.

---

## 2. Backend Implementation

### A. Database & Schemas (`backend/models.py`, `backend/schemas.py`)
1. In `backend/models.py`:
   - Add `space_id` to `SavedPrompt`:
     ```python
     space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id"), default=spaces.DEFAULT_SPACE_ID, index=True)
     ```
   - Update startup migration (in `database.py` or `models.py`) to add the `space_id` column to `saved_prompts` if missing, defaulting to `1`.
2. In `backend/schemas.py`:
   - Add `space_id: int = spaces.DEFAULT_SPACE_ID` to `SavedPromptIn`.
   - Add `space_id: int` to `SavedPrompt`.
   - In `ChatRequest`:
     - Add `reasoning_effort: str | None = None` (allowed: `"low"`, `"medium"`, `"high"`).

### B. Endpoints (`backend/main.py`)
1. In `DEFAULT_PROMPTS`, include:
   - `/prep`:
     - description: "Draft a meeting prep brief"
     - instruction: "Prepare me for an upcoming meeting. Find the meeting note (ask me which meeting if it is not clear), read the notes from the previous meeting of the same series and list which of its action items are open or overdue."
   - `/design-search`:
     - description: "Search configured local folders for design data"
     - instruction: "Search the space's configured local folders using list_local_directory and read_local_file to answer the following: "
   - `/rcd`:
     - description: "Find information in RCD harmonized standards"
     - instruction: "Find information in the RCD regulations in 'Y:\\Classification, Certification & Documentation\\RCD\\All harmonized standards' using list_local_directory and read_local_file to answer the following: "
2. Update `/api/prompts` routes:
   - `GET /api/prompts`: Accept `space_id: int | None = None`. If provided, query `SavedPrompt.space_id == space_id`.
   - `POST /api/prompts`: Save with `request.space_id`. Check uniqueness of `command` per `space_id`.
   - `PUT /api/prompts/{id}`: Update prompt, checking command uniqueness within its `space_id`.
3. In `POST /api/chat`:
   - Pass `request.reasoning_effort` to `agent.run_chat`.

### C. Agent Reasoning Effort & Lightweight RAG Context (`backend/agent.py`)
1. In `agent.run_chat`:
   - Accept `reasoning_effort: str | None = None`.
   - Pass `reasoning_effort=reasoning_effort` to `litellm.completion` if provided. Catch/ignore `UnsupportedParamsError` gracefully if a specific model doesn't support reasoning effort.
2. In `_rag_block`:
   - Avoid flooding 40 filenames into the system prompt on every standard turn.
   - Simplify to:
     ```python
     def _rag_block(folders: list[str]) -> str:
         lines = ["\n\nConfigured Local Folders in this space (crawled when instructed via commands or query, using `list_local_directory` and `read_local_file`):"]
         for folder in folders:
             lines.append(f"- `{folder}`")
         return "\n".join(lines)
     ```

---

## 3. Frontend Implementation

### A. Move Prompt Editor to Space Preferences (`desktop/src/pages/SpacePreferences.tsx`)
1. Add a **Saved Prompts / Commands** section to `SpacePreferences.tsx`:
   - Lists all prompts for the active space (`GET /api/prompts?space_id=${space.id}`).
   - Include "New command" button, edit dialog/form, and delete button.
   - Real-time updates with `window.dispatchEvent(new Event(PROMPTS_CHANGED))`.
2. Remove the prompt editor from `desktop/src/pages/Settings.tsx` and redirect `/settings` to `/space-preferences`.
3. Remove the "Settings" link from `desktop/src/components/Sidebar.tsx`.

### B. Chat Reasoning Effort Selector & Space Prompts (`desktop/src/components/CopilotChat.tsx`)
1. In `CopilotChat.tsx`:
   - Fetch prompts with `space_id`: `/api/prompts?space_id=${spaceId}`.
   - Add a Reasoning Effort selector button and `Popover` next to the Model selector:
     - Button label: `Effort: Auto` / `Low` / `Medium` / `High` (with a brain icon or clean badge).
     - Options:
       - `Auto`: Default (model's native behavior)
       - `Low`: Fast, minimal thinking
       - `Medium`: Balanced reasoning
       - `High`: Deep reasoning & thinking budget
     - Persist selection in `localStorage.setItem("copilot_reasoning_effort", effort)`.
     - Send `reasoning_effort: effort === "auto" ? null : effort` in `POST /api/chat`.

---

## 4. Verification
1. `npm run typecheck` passes.
2. `pytest backend/tests/` passes.
3. Verify `/space-preferences` lists and edits space-specific commands (including `/design-search` and `/rcd`).
4. Verify chat model effort dropdown changes and persists choice.
