# Implementation Plan: Phase 8 - UI Realignment & Slash Commands
**Task ID:** phase-8

## Goal
Scrap the old implementation of Phase 8. The new goal has two parts:
1. **Frontend Overhaul:** Completely redesign the React Desktop and Android apps so they strictly match the HTML/Figma mockups provided in `docs/mockups/screenshots/`.
2. **Saved Prompts (Slash Commands):** Empower the Co-Pilot agent to handle routines (like Meeting Prep) natively. Build a feature allowing the user to trigger saved system prompts via slash commands (e.g., `/prep`) in the chat, along with a Settings UI to manage these custom prompts.

## Scope
### 1. UI Realignment (Frontend)
- **Reference:** Study the HTML source inside `docs/mockups/Main.dc.html` and the images in `docs/mockups/screenshots/` (specifically `4-desktop-today.png`). Note the spacing, colors, and structure. Do NOT blindly copy the HTML structure, but reproduce the exact visual look using Tailwind and React.
- **Desktop Sidebar:** Convert the flat sidebar into the nested tree structure ("NOTES" -> Projects -> Plan/Tasks/Design/Meetings).
- **Today View:** Update the Dashboard to include the time-blocked daily schedule view shown in the mockups.
- **Chat Panel:** Update the Copilot Chat UI (e.g., placing the access mode pill-toggles at the top, cleaning up the message bubbles) to match the mockups.

### 2. Slash Commands / Saved Prompts
- **Data Model:** We need a way to store custom prompts. Since they are user-specific, we can store them in a simple `prompts.json` file on disk in the backend, or within the SQLite database. Let's create a new `SavedPrompt` model in SQLite (with fields: `command`, e.g. `/prep`, and `instruction`, e.g. "Read the open items and draft a meeting prep brief...").
- **Backend API:** Create endpoints (`GET /api/prompts`, `POST /api/prompts`, `DELETE /api/prompts/{id}`) to manage them.
- **Chat Autocomplete:** In `CopilotChat.tsx`, when the user types `/`, pop up a contextual menu listing the available commands.
- **Execution:** When a command is selected (e.g., `/prep`), the corresponding `instruction` string is appended or injected into the message payload sent to the `agent.py`, guiding it to execute the specific task.
- **Settings UI:** Create a "Settings" page or modal (accessible from the sidebar) where the user can create, edit, and delete their custom slash commands.

## Relevant Context
- Meeting Prep should now be handled purely by creating a saved prompt (e.g. `/prep`) that tells the agent to gather the relevant tasks and draft the meeting note. The agent already has the tools to read/write notes and list tasks.

## Files to Modify / Create
- **Backend:** `models.py`, `schemas.py`, `main.py` (for Prompt CRUD)
- **Frontend UI:** `Layout.tsx`, `Dashboard.tsx`, `CopilotChat.tsx`, `Sidebar.tsx` (New, if separated)
- **Frontend Settings:** `Settings.tsx` (New route for managing prompts)
