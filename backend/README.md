# Daily Co-Pilot Backend

Local FastAPI service backed by SQLite. It runs on the work PC and is reachable
from the Android app only over Tailscale — there are no public endpoints.

## Setup

Requires Python 3.11+. From this `backend/` directory (PowerShell):

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt        # runtime
pip install -r requirements-dev.txt    # + pytest/httpx for tests
```

## Configuration

Settings are read from system environment variables and from `backend/.env`
(environment variables win). All names use the `COPILOT_` prefix:

| Variable                    | Default                  | Notes                                             |
|-----------------------------|--------------------------|---------------------------------------------------|
| `COPILOT_DB_PATH`           | `copilot.db`             | Relative paths resolve against `backend/`         |
| `COPILOT_DATA_DIR`          | `data`                   | Spaces root (`data/spaces/<id>/content`, `/templates`); relative to `backend/` |
| `COPILOT_NOTES_DIR`         | `notes`                  | Pre-Phase 9 notes folder, moved into the Default space on startup |
| `COPILOT_HOST`              | `127.0.0.1`              | Used by `python main.py`                          |
| `COPILOT_PORT`              | `8000`                   | Used by `python main.py`                          |
| `COPILOT_OLLAMA_BASE_URL`   | `http://localhost:11434` | Local model endpoint                              |
| `COPILOT_GANTT_MODEL`       | `gemini/gemini-3.1-pro-preview` | litellm model for the Gantt PDF parser     |
| `COPILOT_CHAT_MODEL`        | `gemini/gemini-3.1-pro-preview` | litellm model for the Co-pilot chat agent  |
| `COPILOT_GEMINI_API_KEY`    | unset                    | Needed by the Gantt parser and chat; never hardcode or commit |
| `COPILOT_ANTHROPIC_API_KEY` | unset                    | Optional; never hardcode or commit                |

To get started, copy `.env.example` to `.env` and fill in what you need. `.env` is git-ignored.

## Run the dev server

```powershell
uvicorn main:app --reload
```

Then open http://localhost:8000/health; it should return `{"status": "ok"}`.
On startup the app creates `copilot.db` in this directory if it doesn't exist yet,
and runs the Spaces migration (see [Spaces](#spaces)).
`python main.py` does the same but uses `COPILOT_HOST`/`COPILOT_PORT`.

### Exposing over Tailscale

The default bind address is `127.0.0.1`, which is reachable only from this PC.
To reach the API from the phone, bind to this PC's Tailscale IP (find it with
`tailscale ip -4`) so the API is reachable only on the tailnet:

```powershell
uvicorn main:app --host 100.x.y.z --port 8000
```

Don't bind to `0.0.0.0`: that would also expose the API on the office LAN.

## Spaces

A **Space** is the top-level boundary: every note, folder and task belongs to one
space, and the desktop app, task views and Co-pilot only ever see the active one.
Each space has a folder under `COPILOT_DATA_DIR`:

```
data/spaces/<space_id>/content/     the notes: a free folder tree (Confluence-style)
data/spaces/<space_id>/templates/   markdown templates for new notes
```

On startup `spaces.migrate` (called from `main.py`) makes a pre-Phase 9 install fit:
it creates the `Default` space (id 1), moves `COPILOT_NOTES_DIR` (`notes/`) to
`data/spaces/1/content/`, puts tasks without a space into it, and gives every space its
`content/` and `templates/` folders (a new `templates/` gets two starter templates). It
runs on every start and does nothing once done. If `data/spaces/1/content/` already has
notes, the old folder is left alone and a warning is logged: merge it by hand. Note
paths relative to the root don't change, so note history still lines up.

Every endpoint that reads notes or tasks takes a `space_id` (query parameter or body
field, default `1`); an unknown space returns 404.

- `GET /api/spaces` lists the spaces; `POST /api/spaces` `{"name": "Private"}` creates one (201).
- `GET /api/tree?space_id=1` returns the `content/` tree, empty folders included and
  hidden ones skipped: `{"space_id", "content": FolderNode, "templates": [{"path", "title"}]}`,
  where a `FolderNode` is `{"name", "path", "is_project", "is_reference", "project_id",
  "folders": [...], "notes": [{"path", "title"}]}`.
- `PUT /api/folders/meta` `{"space_id", "path", "is_project"?, "is_reference"?}` marks or
  unmarks a folder (`FolderMeta` row; unsent flags are kept).
- `POST /api/folders` `{"space_id", "path"}` creates a folder (409 if it exists).
- `POST /api/notes` `{"space_id", "path", "title"?, "template"?}` creates a note (409 if it
  exists; `.md` is added if missing). With `template` (a path in `templates/`) the note
  gets the template's front-matter and body, with `{title}` and `{date}` filled in.

**Project folders.** Marking a folder as a Project links it to a `Project` row: the one
whose code is the folder name (so a `C7801` folder picks up the imported C7801 Gantt),
unless another folder already claims it, else a new project. Tasks are grouped by that
project. Unmarking keeps the link, so marking the folder again brings its tasks back.
A note belongs to its nearest enclosing project folder.

**Reference Data folders.** The Co-pilot puts the notes of every Reference Data folder of
the space into its system prompt (up to 40,000 characters; the rest are listed by path).

## Task engine

Tasks are `Task` rows in SQLite (not markdown checklists), each in a space and
optionally in a project. Statuses: `backlog`, `todo`, `in_progress`, `blocked`, `done`.
Gantt imports land here too (`is_gantt_task=True`).

- `GET /api/tasks?space_id=1` lists a space's tasks, earliest due date first, as
  `TaskItem`s (`project_code`, `completion_percent`, linked `note_paths`, …). Filters:
  `project_id`, `status`, `note_path` (tasks linked to that note) and `assignee` (an
  empty `assignee=` means unassigned).
- `POST /api/tasks` `{"space_id", "title", "project_id"?, "status"?, "start_date"?,
  "deadline"?, "assignee"?, "note_paths"?}` creates a task (201; default status `backlog`).
- `GET /api/tasks/{id}`; `PATCH /api/tasks/{id}` changes any of `title`, `description`,
  `status`, `priority`, `assignee`, `project_id`, `start_date`, `deadline`;
  `DELETE /api/tasks/{id}` soft-deletes it (204).
- `POST /api/tasks/{id}/links` `{"note_path"}` links a note of the task's space
  (`TaskNoteLink`, many-to-many); `DELETE /api/tasks/{id}/links?note_path=...` unlinks it.
- `GET /api/projects?space_id=1` lists the space's projects (those with tasks or a project
  folder in it; a project with neither belongs to the Default space) for filters and pickers.

`/api/gantt`, `/api/triage` and `/api/capture` are per space too. `cli_import.py`
imports into the Default space unless given `--space <id>`.

## Capture API

`POST /api/capture` saves a quick note from the Android app as a markdown file:

```json
{"content": "Check weld spec", "project": "C7801", "priority": "High"}
```

`project` defaults to `Inbox` and must be a plain code (letters, digits, `-`, `_`);
`priority` is `Low`, `Normal`, `High` or `Urgent` (any case). The note is written to
`<project>/Notes-in/Capture_<YYYYMMDD_HHMMSS>.md` (or `Inbox/Capture_<...>.md`) in the
`content/` folder of `space_id` (optional, default the Default space), with front-matter `type: capture`, `project`, `priority` and
`created`, plus `source` (e.g. `verbal`, `meeting`) if the request sends one. The
response is `{"path": "<path relative to content/>"}`, and the change is logged in
`history` with source `android_app`.

## Evening check-in API

`POST /api/checkin` closes out the day in one transaction:

```json
{
  "completed_task_ids": [12, 15],
  "time_entries": [{"project": "C7801", "hours": 4, "notes": "Gelcoat"}, {"project": "Inbox", "hours": 0.5}]
}
```

Each task is set to `done` with `completed_at` (tasks already done keep their original
time), so it drops off `/api/triage`. Each time entry becomes a `TimeLog` row for
`day` (optional, defaults to today); `hours` must be above 0 and at most 24. A project of
`Inbox`, `Overhead` or `null` logs the time without a project, and a project code with
no row yet (e.g. a project whose Gantt hasn't been imported) is created on the fly.
Unknown task ids return 404 and nothing is saved. Changes are logged in `history`
with source `evening_checkin`. The response is
`{"completed_task_ids": [...], "time_log_ids": [...], "total_hours": 4.5}`.

## Co-pilot chat API

`POST /api/chat` runs one turn of the Co-pilot agent (`agent.py`). The server keeps no
chat state, so the client sends the whole conversation, ending with a user message:

```json
{
  "messages": [{"role": "user", "content": "What is currently overdue on C7801?"}],
  "access_mode": "ask_first",
  "space_id": 1,
  "note_path": "C7801/Meetings/Design review.md"
}
```

The agent only sees the `space_id` space: its tools search, read and write that space's
`content/` and list its tasks. Its system prompt includes the space's Reference Data
notes and, when `note_path` (the note the user has open) is inside a Project folder, that
project's open tasks plus any tasks linked to the note.

The model (`COPILOT_CHAT_MODEL`, via litellm) can call `search_notes`, `read_note`,
`list_tasks` (tasks from SQLite with an `overdue` flag) and `write_note`, for up to
8 rounds. `access_mode` decides what `write_note` does; it is enforced by `file_layer`:

| Mode             | `write_note`                                                          |
|------------------|-----------------------------------------------------------------------|
| `read_only`      | Not offered to the model, and refused if it is called anyway          |
| `ask_first`      | Nothing is written; the change is returned in `proposed_edits` (default) |
| `write_directly` | Written at once and listed in `written_paths`; history source `copilot_agent` |

The response is `{"reply": "<markdown>", "proposed_edits": [...], "written_paths": [...],
"tool_calls": [{"name", "arguments", "ok"}]}`. Each proposed edit carries the new
`content`/`frontmatter`, the current `previous_content`/`previous_frontmatter` (null for
a new note) and `base_hash`, the SHA-256 of the note file when it was proposed.

`POST /api/notes/apply-edit` commits an edit the user approved: send `space_id`, `path`, `content`,
`frontmatter` and `base_hash` from the proposal. If the note changed since then (or a
"new" note now exists) it returns 409 and writes nothing. The write is recorded in
`history` with source `copilot_agent_approved`. Without `COPILOT_GEMINI_API_KEY`,
`/api/chat` returns 503; a failing model call returns 502.

## Saved prompts (slash commands)

Saved prompts are routines the user triggers in the desktop chat by starting a message
with their command, e.g. `/prep Friday design review`. They are `SavedPrompt` rows:

```json
{"command": "/prep", "description": "Draft a meeting prep brief", "instruction": "Prepare me for an upcoming meeting..."}
```

- `GET /api/prompts` lists them by command.
- `POST /api/prompts` creates one (201); `PUT /api/prompts/{id}` replaces one.
- `DELETE /api/prompts/{id}` soft-deletes one (204).

`command` is lower-cased and gets a leading `/` if missing; it must be up to 31
letters, digits, `-` or `_`. A command already used by another live prompt returns
409. Changes are logged in `history` with source `settings`. On startup a database
that has never had any prompts gets a default `/prep` for meeting prep.

The prompt is expanded by the desktop app, not the server: the user message sent to
`/api/chat` becomes `[Saved prompt /prep]`, the instruction, and `User input: ...` for
any text after the command. The agent's system prompt tells it to follow such routines.

## Notes API

`GET /api/notes?space_id=1` lists every note of a space (hidden folders skipped) as
`{"path", "title"}`; the title is the front-matter `title`, else the first line of the
content, else the file name. `GET /api/notes/file?space_id=1&path=<path>` returns one note
as `{"path", "frontmatter", "content"}` (404 if missing, 400 for paths outside the
folder); add `root=templates` to read a template instead.

## Gantt PDF parser

`gantt_parser.extract_gantt_data(pdf_path)` reads a Gantt PDF export with PyMuPDF
and asks Gemini (via litellm) to turn it into JSON with `tasks` (name, parent,
trade, start/end, percent complete), finish-to-start `dependencies` and
`milestones`. Text is sent with page coordinates so that dates can be read off
the bar positions when a chart has no date columns. Treat the output as a draft
for human review; it is not written to the database. Requires `COPILOT_GEMINI_API_KEY`.

```python
from gantt_parser import extract_gantt_data
data = extract_gantt_data("../docs/gantt/C7801 Project Plan.pdf")
print(data["tasks"][:2])
```

### Reviewing and importing a Gantt

`cli_import.py` runs the extraction, prints the JSON and a summary (project,
task/milestone/dependency counts, date range), then asks
`Approve and import to database? [Y/N]`. On `Y` it creates or updates the
`Project` and stores tasks and milestones as `Task` rows with `is_gantt_task=True`
(milestones also get `is_milestone=True`), plus their finish-to-start `Link`s.

```powershell
python cli_import.py "../docs/gantt/C7801 Project Plan.pdf"
python cli_import.py plan.pdf --code C7801   # if no project code can be found
```

Re-importing a project soft-deletes its previous Gantt tasks (and their links)
before inserting the new ones; tasks that didn't come from the Gantt are kept.

## Version history

Nothing is ever hard-deleted. `Project`, `Task` and `Link` rows have a
`deleted_at` column; `history.soft_delete(session, obj)` sets it (deleting a
project also deletes its tasks, deleting a task also deletes its links) and
`history.restore(obj)` clears it. Soft-deleted rows are hidden from ORM queries
unless you pass `.execution_options(include_deleted=True)`. The foreign keys no
longer cascade, so a hard `session.delete()` of a row that others point to fails.

Every change is appended to the `history` table with a full JSON snapshot:

| Column        | Meaning                                                        |
|---------------|----------------------------------------------------------------|
| `entity_type` | `Project`, `Task`, `Link` or `Note`                            |
| `entity_id`   | Row id; for notes the path in the Default space's `content/`, else `spaces/<id>/content/<path>` |
| `action`      | `create`, `update`, `delete` or `rename` (notes only)          |
| `source`      | Who made the change: `manual` (default), `cli_import`, `copilot_agent`, ... |
| `timestamp`   | UTC                                                            |
| `snapshot`    | The entity's full state after the change (before it, for deletes) |

Database changes are recorded automatically on flush; set the actor with
`history.set_source(session, "gemini")` (or `sessionmaker(info={"source": ...})`).
`cli_import.py` records its changes as `cli_import`. Note changes made through
`file_layer.write_note`, `rename_note` and `delete_note` take a `source=` argument;
a deleted note's last content stays in its `delete` snapshot.

`init_db()` adds the new columns to databases created by earlier versions.

```powershell
python -c "import sqlite3; [print(r) for r in sqlite3.connect('copilot.db').execute('SELECT id, entity_type, entity_id, action, source, timestamp FROM history')]"
```

## Tests

```powershell
pytest
```
