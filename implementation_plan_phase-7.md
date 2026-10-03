# Implementation Plan: Phase 7 - Co-pilot Chat and Agent
**Task ID:** phase-7

## Goal
Build the conversational agent interface that can read and modify the markdown-backed Knowledge Base (Notes and Library), complete with tool calling and user access controls (Read Only, Ask First, Write Directly).

## Scope
### Backend (FastAPI + LLM adapter)
- **Chat Endpoint:** `POST /api/chat` in `backend/main.py`.
- **LLM Adapter:** Use LiteLLM or the native Gemini library to communicate with the model (using `COPILOT_GEMINI_API_KEY`).
- **Tool Calling:**
  - `read_note`: Reads a specific note using `file_layer.py`.
  - `search_notes`: Searches across notes.
  - `write_note`: Modifies or creates a note.
- **Access Control:** The backend must respect an access mode parameter passed by the client.
  - `read_only`: Tool `write_note` is disabled.
  - `ask_first`: Tool `write_note` does not actually write to disk. Instead, the endpoint returns a structured "proposed edit" which the frontend renders for user approval.
  - `write_directly`: Tool `write_note` applies the change to disk immediately (logging it to the unified history table).

### Frontend (React + Vite)
- **Chat Pane:** Build a `CopilotChat.tsx` interface. This could be a slide-over panel on the right side of the screen, or a dedicated `/chat` route.
- **Message Rendering:** Handle Markdown rendering for bot messages.
- **Tool UI:** If the backend returns a "proposed edit" (from `ask_first` mode), render a diff or preview component with "Approve" and "Reject" buttons. When approved, hit a `POST /api/notes/apply-edit` endpoint (or similar) to commit it.
- **Settings:** A simple toggle/dropdown in the Chat header for the Access Mode.

## Relevant Context
- The agent is the core feature that turns the system from a passive tracker into an active "co-pilot". It needs to be able to answer questions like "What did we decide about the keel design in C7801?" by searching the notes.
- Every write action must still route through the `history` mixin to ensure the audit trail remains intact!

## Files to Modify / Create
- `backend/agent.py` (New file for LLM tool calling logic)
- `backend/main.py`
- `backend/schemas.py`
- `desktop/src/components/CopilotChat.tsx` (New)
- `desktop/src/pages/Dashboard.tsx` or `Layout.tsx` (to embed the chat)

## User-Driven Manual Test Plan
1. Start the services.
2. Open the Chat pane.
3. Ask the agent: "What is currently overdue on C7801?"
4. Ask the agent to write a new note in the C7801 project summarizing the tasks.
5. Test the `ask_first` mode and verify the UI shows an Approval block before writing to disk.
