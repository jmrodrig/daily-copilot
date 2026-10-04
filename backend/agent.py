"""Co-pilot chat agent: an LLM (via litellm) with tools over the notes and the task database.

Everything the agent sees is limited to the active space: its `content/` notes and its tasks.

The tools the model may call:

- `search_notes`: keyword search across the space's markdown notes.
- `read_note`: read one note with its front-matter.
- `list_tasks`: the space's tasks from SQLite (status, dates, overdue flag).
- `write_note`: create or replace a note. Only offered outside `read_only` mode.

Context injected into the system prompt (see `space_context`):

- the contents of every folder marked as Reference Data in the space;
- when the user has a note open inside a Project folder, that project's open tasks
  (and the tasks linked to the note).

Writes go through `file_layer.write_note`, which enforces the access mode and records
every change in `history`. In `ask_first` mode the file layer refuses the write with
`ApprovalRequiredError`; the agent turns that into a `ProposedEdit` for the user to
approve (see `POST /api/notes/apply-edit`).
"""

import functools
import glob
import json
from collections.abc import Callable, Sequence
from datetime import date
from pathlib import Path
from typing import Any

import litellm
import yaml
from sqlalchemy import func, or_, select

import database
import file_layer
import spaces
from config import Settings, get_settings
from models import FolderMeta, Project, Space, Task, TaskNoteLink
from schemas import AccessMode, ChatMessage, ChatResponse, ProposedEdit, Status, ToolCallSummary

# History sources: the agent writing by itself, and the user approving a proposed edit.
AGENT_SOURCE = "copilot_agent"
APPROVED_SOURCE = "copilot_agent_approved"

MAX_TOOL_ROUNDS = 8
SEARCH_LIMIT = 10
READ_LIMIT = 20_000  # characters of note content returned to the model
_SNIPPET_RADIUS = 80
REFERENCE_LIMIT = 40_000  # characters of Reference Data notes put into the system prompt
CONTEXT_TASK_LIMIT = 50  # project tasks put into the system prompt


class AgentError(Exception):
    """The model could not be reached or answered badly."""


class AgentNotConfiguredError(AgentError):
    """No API key is configured for the chat model."""


class ToolError(Exception):
    """A tool call failed; the message is returned to the model so it can recover."""


SYSTEM_PROMPT = """\
You are the Daily Co-Pilot, an assistant for a naval architect managing boat build projects \
(project codes such as C7801, R5301, P5002). You answer questions from the user's knowledge base: \
markdown notes (meeting notes, design decisions, captures) and the project task database \
imported from the shop floor Gantt charts.

Today is {today}.

You work inside one Space ("{space_name}"): every note path and task you see belongs to it.

Notes layout: a free folder tree. Folders marked as Projects group a project's notes, and its tasks live \
in the task database. Quick captures land in `<project>/Notes-in/` or `Inbox/`. \
Notes may start with YAML front-matter (type, project, tags, created).

Rules:
- Look things up with the tools before answering; do not guess. Cite note paths you relied on.
- For schedule questions (overdue, due soon, who is on what) use `list_tasks`.
- Keep answers short and practical. Use markdown.
- A message starting with `[Saved prompt /<command>]` is one of the user's saved routines (e.g. /prep for \
meeting prep): carry out its instruction with the tools, using any `User input:` that follows it.
- `[The user is looking at ...]` says which page or note the user has open; "this page" or "this note" means it.
{write_rules}{context}"""

_WRITE_RULES = {
    AccessMode.READ_ONLY: "- You are in READ ONLY mode: you cannot create or change notes. "
    "If asked to, explain that the user must switch the access mode.",
    AccessMode.ASK_FIRST: "- You are in ASK FIRST mode: `write_note` only proposes the change; the user "
    "approves or rejects it in the chat. Tell the user the edit is waiting for their approval.",
    AccessMode.WRITE_DIRECTLY: "- You are in WRITE DIRECTLY mode: `write_note` saves the note immediately. "
    "Tell the user which note you wrote.",
}
_WRITE_GUIDE = (
    "\n- `write_note` replaces the whole note: to edit, read the note first and send the full new content."
    "\n- New notes go in the project's folder, e.g. `C7801/Task summary 2026-10-03.md`."
)

_PATH_PARAM = {"type": "string", "description": "Note path relative to the notes folder, e.g. `C7801/Keel.md`"}

TOOLS: dict[str, dict[str, Any]] = {
    "search_notes": {
        "description": "Keyword search across all notes (path, front-matter and content). "
        "Returns the best matches with a snippet. An empty query lists the most recently changed notes.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords, e.g. `keel design`"},
                "project": {
                    "type": "string",
                    "description": "Optional project code or folder path (e.g. `C7801/Design`) to limit the search to",
                },
            },
            "required": ["query"],
        },
    },
    "read_note": {
        "description": "Read one note: its front-matter and markdown content.",
        "parameters": {"type": "object", "properties": {"path": _PATH_PARAM}, "required": ["path"]},
    },
    "list_tasks": {
        "description": "List project tasks from the database with status, assignee, start date, deadline, "
        "completion and an `overdue` flag. Finished tasks are left out unless `include_done` is true.",
        "parameters": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Optional project code or project folder, e.g. C7801"},
                "overdue_only": {"type": "boolean", "description": "Only tasks past their deadline"},
                "include_done": {"type": "boolean", "description": "Also list finished tasks"},
            },
        },
    },
    "write_note": {
        "description": "Create a note or replace an existing one with the full new content.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": _PATH_PARAM,
                "content": {"type": "string", "description": "Full markdown body, without front-matter"},
                "frontmatter": {
                    "type": "object",
                    "description": "YAML front-matter fields. Omit to keep an existing note's front-matter.",
                },
            },
            "required": ["path", "content"],
        },
    },
}


def _tool_specs(mode: AccessMode) -> list[dict[str, Any]]:
    names = [name for name in TOOLS if not (name == "write_note" and mode is AccessMode.READ_ONLY)]
    return [{"type": "function", "function": {"name": name, **TOOLS[name]}} for name in names]


# --- Tools --------------------------------------------------------------------


def _note_text(note: dict[str, Any]) -> str:
    frontmatter = yaml.safe_dump(note["frontmatter"], allow_unicode=True) if note["frontmatter"] else ""
    return f"{note['path']}\n{frontmatter}\n{note['content']}"


def _snippet(text: str, terms: Sequence[str]) -> str:
    lower = text.lower()
    hit = min((i for i in (lower.find(t) for t in terms) if i >= 0), default=0)
    start = max(hit - _SNIPPET_RADIUS, 0)
    snippet = " ".join(text[start : hit + _SNIPPET_RADIUS].split())
    return ("…" if start else "") + snippet + ("…" if hit + _SNIPPET_RADIUS < len(text) else "")


def _folder_pattern(root: Path, folder: str) -> str:
    """Glob for the notes under `folder` (relative to `root`), refusing folders outside it."""
    resolved = (root / folder.strip().strip("/")).resolve()
    if not resolved.is_relative_to(root) or resolved == root:
        raise ToolError(f"Not a project or folder: {folder}")
    return f"{glob.escape(resolved.relative_to(root).as_posix())}/**/*.md"


def search_notes(query: str, project: str | None = None, *, notes_dir: Path | None = None) -> dict[str, Any]:
    root = file_layer.notes_root(notes_dir)
    terms = [t for t in query.lower().split() if len(t) > 1]
    pattern = _folder_pattern(root, project) if project else "**/*.md"
    scored = []
    for path in file_layer.list_notes(pattern, notes_dir=root):
        try:
            note = file_layer.read_note(path, notes_dir=root)
        except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
            continue  # A broken note must not break the search.
        text = _note_text(note)
        lower = text.lower()
        matched = sum(1 for t in terms if t in lower)
        if terms and not matched:
            continue
        # Notes matching more of the terms first, then more hits, then the most recently changed.
        key = (-matched, -sum(lower.count(t) for t in terms), -(root / path).stat().st_mtime)
        scored.append((key, path, note, text))
    scored.sort(key=lambda item: item[0])
    return {
        "total_matches": len(scored),
        "results": [
            {
                "path": path,
                "project": note["frontmatter"].get("project") or path.split("/")[0],
                "type": note["frontmatter"].get("type"),
                "snippet": _snippet(note["content"] or text, terms),
            }
            for _key, path, note, text in scored[:SEARCH_LIMIT]
        ],
    }


def read_note(path: str, *, notes_dir: Path | None = None) -> dict[str, Any]:
    try:
        note = file_layer.read_note(path, notes_dir=notes_dir)
    except FileNotFoundError:
        raise ToolError(f"No note at {path}; use search_notes to find the right path") from None
    content = note["content"]
    if len(content) > READ_LIMIT:
        content = content[:READ_LIMIT] + f"\n\n[… truncated, {len(note['content'])} characters in total]"
    return {"path": note["path"], "frontmatter": note["frontmatter"], "content": content}


def _project_id(session: Any, space_id: int, project: str) -> int | None:
    """A project by its folder in the space (case-insensitive) or by its code."""
    folder = project.strip().strip("/").lower()
    for meta in session.scalars(select(FolderMeta).where(FolderMeta.space_id == space_id, FolderMeta.is_project.is_(True))):
        if meta.path.lower() == folder:
            return meta.project_id
    return session.scalar(select(Project.id).where(func.upper(Project.code) == project.strip().upper()))


def list_tasks(
    project: str | None = None,
    overdue_only: bool = False,
    include_done: bool = False,
    *,
    space_id: int = spaces.DEFAULT_SPACE_ID,
    project_id: int | None = None,
) -> dict[str, Any]:
    today = date.today()
    query = (
        select(Task, Project.code)
        .outerjoin(Project, Task.project_id == Project.id)
        .where(
            func.coalesce(Task.space_id, spaces.DEFAULT_SPACE_ID) == space_id,
            or_(Task.project_id.is_(None), Project.active.is_(True)),
        )
    )
    with database.SessionLocal() as session:
        if project and project_id is None:
            project_id = _project_id(session, space_id, project)
            if project_id is None:
                raise ToolError(f"No project {project} in this space")
        if project_id is not None:
            query = query.where(Task.project_id == project_id)
        rows = session.execute(query).all()
    tasks = []
    for task, code in rows:
        percent = task.completion_percent
        done = task.status == Status.DONE or percent >= 100
        overdue = not done and task.deadline is not None and task.deadline < today
        if (done and not include_done) or (overdue_only and not overdue):
            continue
        tasks.append(
            {
                "id": task.id,
                "project": code,
                "title": task.title,
                "status": task.status.value,
                "assignee": task.assignee,
                "start_date": task.start_date.isoformat() if task.start_date else None,
                "deadline": task.deadline.isoformat() if task.deadline else None,
                "completion_percent": percent,
                "overdue": overdue,
                "is_milestone": task.is_milestone,
            }
        )
    tasks.sort(key=lambda t: (t["project"] or "", t["deadline"] is None, t["deadline"] or "", t["id"]))
    return {"today": today.isoformat(), "count": len(tasks), "tasks": tasks}


# --- Space context -------------------------------------------------------------


def _reference_block(root: Path, folders: Sequence[str]) -> str:
    """The notes of the Reference Data folders, up to `REFERENCE_LIMIT` characters in total."""
    included, skipped, budget = [], [], REFERENCE_LIMIT
    for folder in folders:
        for path in file_layer.list_notes(f"{glob.escape(folder)}/**/*.md", notes_dir=root):
            try:
                text = _note_text(file_layer.read_note(path, notes_dir=root))
            except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
                continue
            if len(text) > budget:
                skipped.append(path)
                continue
            budget -= len(text)
            included.append(f"<reference_note>\n{text.strip()}\n</reference_note>")
    lines = [
        "\n\nReference Data (always relevant in this space; folders: "
        + ", ".join(f"`{f}`" for f in folders)
        + "). Use it without being asked:"
    ]
    lines += included or ["(The reference folders have no notes yet.)"]
    if skipped:
        lines.append("Not included for length (use `read_note`): " + ", ".join(f"`{p}`" for p in skipped))
    return "\n".join(lines)


def _task_line(task: dict[str, Any]) -> str:
    parts = [f"#{task['id']} {task['title']}", task["status"]]
    if task["assignee"]:
        parts.append(f"assignee {task['assignee']}")
    if task["start_date"]:
        parts.append(f"start {task['start_date']}")
    if task["deadline"]:
        parts.append(f"due {task['deadline']}" + (" (OVERDUE)" if task["overdue"] else ""))
    return "- " + " · ".join(parts)


def space_context(space_id: int, note_path: str | None = None) -> tuple[str, str]:
    """(space name, extra system prompt text) for a chat in `space_id` with `note_path` open."""
    root = spaces.content_dir(space_id)
    with database.SessionLocal() as session:
        space = session.get(Space, space_id)
        metas = spaces.folder_metas(session, space_id)
        project_meta = spaces.project_folder_for(metas, note_path) if note_path else None
        project = session.get(Project, project_meta.project_id) if project_meta and project_meta.project_id else None
        linked_ids = (
            list(session.scalars(select(TaskNoteLink.task_id).where(TaskNoteLink.note_path == note_path)))
            if note_path
            else []
        )
    name = space.name if space else spaces.DEFAULT_SPACE_NAME
    blocks = []

    references = sorted(path for path, meta in metas.items() if meta.is_reference and (root / path).is_dir())
    if references:
        blocks.append(_reference_block(root, references))

    if project is not None:
        tasks = list_tasks(space_id=space_id, project_id=project.id)["tasks"]
        lines = [
            f"\n\nThe open note is in the project folder `{project_meta.path}` (project {project.code}, "
            f"{project.name}). Its open tasks ({len(tasks)}):"
        ]
        lines += [_task_line(t) for t in tasks[:CONTEXT_TASK_LIMIT]] or ["(no open tasks)"]
        if len(tasks) > CONTEXT_TASK_LIMIT:
            lines.append(f"… and {len(tasks) - CONTEXT_TASK_LIMIT} more; use `list_tasks`.")
        blocks.append("\n".join(lines))

    if linked_ids:
        everything = list_tasks(space_id=space_id, include_done=True)["tasks"]
        linked = [t for t in everything if t["id"] in set(linked_ids)]
        if linked:
            blocks.append("\n\nTasks linked to the open note:\n" + "\n".join(_task_line(t) for t in linked))
    return name, "".join(blocks)


class _Turn:
    """Tool state for one chat turn: the access mode, the space, and what the agent wrote or proposed."""

    def __init__(self, mode: AccessMode, space_id: int = spaces.DEFAULT_SPACE_ID):
        self.mode = mode
        self.space_id = space_id
        self.root = spaces.content_dir(space_id)
        self.proposed: dict[str, ProposedEdit] = {}  # by path; a later proposal replaces an earlier one
        self.written: list[str] = []

    def write_note(self, path: str, content: str, frontmatter: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.mode is AccessMode.READ_ONLY:
            raise ToolError("Notes are read only in this conversation")
        rel = file_layer.resolve_note_path(path, self.root).relative_to(self.root.resolve()).as_posix()
        try:
            current = file_layer.read_note(rel, notes_dir=self.root)
        except FileNotFoundError:
            current = None
        if frontmatter is None:
            frontmatter = current["frontmatter"] if current else {}
        if not isinstance(frontmatter, dict):
            raise ToolError("frontmatter must be an object")

        try:
            written = file_layer.write_note(
                rel, content, frontmatter, self.mode, notes_dir=self.root, source=AGENT_SOURCE
            )
        except file_layer.ApprovalRequiredError:
            if current is not None and (current["content"], current["frontmatter"]) == (content, frontmatter):
                return {"status": "unchanged", "path": rel}
            self.proposed[rel] = ProposedEdit(
                path=rel,
                content=content,
                frontmatter=frontmatter,
                previous_content=current["content"] if current else None,
                previous_frontmatter=current["frontmatter"] if current else None,
                base_hash=file_layer.note_hash(rel, notes_dir=self.root),
            )
            return {"status": "proposed", "path": rel, "message": "Waiting for the user's approval in the chat"}
        if written and rel not in self.written:
            self.written.append(rel)
        return {"status": "written" if written else "unchanged", "path": rel}

    def call(self, name: str, arguments: dict[str, Any]) -> Any:
        tools: dict[str, Callable[..., Any]] = {
            "search_notes": functools.partial(search_notes, notes_dir=self.root),
            "read_note": functools.partial(read_note, notes_dir=self.root),
            "list_tasks": functools.partial(list_tasks, space_id=self.space_id),
            "write_note": self.write_note,
        }
        if name not in tools or (name == "write_note" and self.mode is AccessMode.READ_ONLY):
            raise ToolError(f"Unknown tool: {name}")
        try:
            return tools[name](**arguments)
        except TypeError as exc:
            raise ToolError(f"Bad arguments for {name}: {exc}") from exc
        except (file_layer.FileLayerError, OSError, UnicodeDecodeError) as exc:
            raise ToolError(str(exc)) from exc


# --- Chat loop ----------------------------------------------------------------


def _summary(name: str, arguments: dict[str, Any], ok: bool) -> ToolCallSummary:
    # Note bodies are shown as proposed edits, not repeated in the tool call list.
    return ToolCallSummary(name=name, arguments={k: v for k, v in arguments.items() if k != "content"}, ok=ok)


def _run_tool(turn: _Turn, name: str, raw_arguments: str | None) -> tuple[str, ToolCallSummary]:
    try:
        arguments = json.loads(raw_arguments or "{}")
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object")
    except ValueError as exc:
        return json.dumps({"error": f"Invalid arguments: {exc}"}), _summary(name, {}, False)
    try:
        result, ok = turn.call(name, arguments), True
    except ToolError as exc:
        result, ok = {"error": str(exc)}, False
    return json.dumps(result, default=str, ensure_ascii=False), _summary(name, arguments, ok)


def run_chat(
    messages: Sequence[ChatMessage],
    access_mode: AccessMode,
    *,
    space_id: int = spaces.DEFAULT_SPACE_ID,
    note_path: str | None = None,
    settings: Settings | None = None,
) -> ChatResponse:
    """Answer the last user message in `space_id`, calling tools as the model asks, for up to
    `MAX_TOOL_ROUNDS` rounds. `note_path` is the note the user has open, if any."""
    settings = settings or get_settings()
    if settings.gemini_api_key is None:
        raise AgentNotConfiguredError("COPILOT_GEMINI_API_KEY is not set; add it to backend/.env")

    mode = AccessMode(access_mode)
    write_rules = _WRITE_RULES[mode] + ("" if mode is AccessMode.READ_ONLY else _WRITE_GUIDE)
    space_name, context = space_context(space_id, note_path)
    system = SYSTEM_PROMPT.format(
        today=date.today().isoformat(), write_rules=write_rules, space_name=space_name, context=context
    )
    history: list[Any] = [{"role": "system", "content": system}]
    history += [{"role": m.role.value, "content": m.content} for m in messages]
    turn, summaries = _Turn(mode, space_id), []

    for round_ in range(MAX_TOOL_ROUNDS + 1):
        last = round_ == MAX_TOOL_ROUNDS  # Out of rounds: make the model answer with what it has.
        try:
            response = litellm.completion(
                model=settings.chat_model,
                api_key=settings.gemini_api_key.get_secret_value(),
                messages=history,
                tools=_tool_specs(mode),
                tool_choice="none" if last else "auto",
            )
        except Exception as exc:  # litellm raises many provider-specific types
            raise AgentError(f"The chat model failed: {exc}") from exc
        message = response.choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []
        if not tool_calls or last:
            return ChatResponse(
                reply=message.content or "(The model returned no answer.)",
                proposed_edits=list(turn.proposed.values()),
                written_paths=turn.written,
                tool_calls=summaries,
            )
        # Keep the provider's message object as is: Gemini needs its thought signatures echoed back.
        history.append(message)
        for call in tool_calls:
            result, summary = _run_tool(turn, call.function.name, call.function.arguments)
            summaries.append(summary)
            history.append({"role": "tool", "tool_call_id": call.id, "name": call.function.name, "content": result})
    raise AssertionError("unreachable")
