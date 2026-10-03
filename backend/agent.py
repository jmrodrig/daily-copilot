"""Co-pilot chat agent: an LLM (via litellm) with tools over the notes and the task database.

The tools the model may call:

- `search_notes`: keyword search across the markdown notes.
- `read_note`: read one note with its front-matter.
- `list_tasks`: project tasks from SQLite (status, dates, overdue flag).
- `write_note`: create or replace a note. Only offered outside `read_only` mode.

Writes go through `file_layer.write_note`, which enforces the access mode and records
every change in `history`. In `ask_first` mode the file layer refuses the write with
`ApprovalRequiredError`; the agent turns that into a `ProposedEdit` for the user to
approve (see `POST /api/notes/apply-edit`).
"""

import json
import re
from collections.abc import Callable, Sequence
from datetime import date
from typing import Any

import litellm
import yaml
from sqlalchemy import select

import database
import file_layer
from config import Settings, get_settings
from models import Project, Task
from schemas import AccessMode, ChatMessage, ChatResponse, ProposedEdit, Status, ToolCallSummary

# History sources: the agent writing by itself, and the user approving a proposed edit.
AGENT_SOURCE = "copilot_agent"
APPROVED_SOURCE = "copilot_agent_approved"

MAX_TOOL_ROUNDS = 8
SEARCH_LIMIT = 10
READ_LIMIT = 20_000  # characters of note content returned to the model
_SNIPPET_RADIUS = 80
_PROJECT_RE = re.compile(r"^[A-Za-z0-9_-]+$")  # a project code is also a folder name


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

Notes layout: `<project>/...` folders per project; quick captures land in `<project>/Notes-in/` \
or `Inbox/`. Notes may start with YAML front-matter (type, project, tags, created).

Rules:
- Look things up with the tools before answering; do not guess. Cite note paths you relied on.
- For schedule questions (overdue, due soon, who is on what) use `list_tasks`.
- Keep answers short and practical. Use markdown.
- A message starting with `[Saved prompt /<command>]` is one of the user's saved routines (e.g. /prep for \
meeting prep): carry out its instruction with the tools, using any `User input:` that follows it.
- `[The user is looking at ...]` says which page or note the user has open; "this page" or "this note" means it.
{write_rules}"""

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
                "project": {"type": "string", "description": "Optional project code to limit the search to"},
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
                "project": {"type": "string", "description": "Optional project code, e.g. C7801"},
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


def search_notes(query: str, project: str | None = None) -> dict[str, Any]:
    if project and not _PROJECT_RE.match(project):
        raise ToolError(f"Not a project code: {project}")
    terms = [t for t in query.lower().split() if len(t) > 1]
    pattern = f"{project}/**/*.md" if project else "**/*.md"
    root = file_layer.notes_root()
    scored = []
    for path in file_layer.list_notes(pattern):
        try:
            note = file_layer.read_note(path)
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


def read_note(path: str) -> dict[str, Any]:
    try:
        note = file_layer.read_note(path)
    except FileNotFoundError:
        raise ToolError(f"No note at {path}; use search_notes to find the right path") from None
    content = note["content"]
    if len(content) > READ_LIMIT:
        content = content[:READ_LIMIT] + f"\n\n[… truncated, {len(note['content'])} characters in total]"
    return {"path": note["path"], "frontmatter": note["frontmatter"], "content": content}


def list_tasks(project: str | None = None, overdue_only: bool = False, include_done: bool = False) -> dict[str, Any]:
    today = date.today()
    query = select(Task, Project.code).join(Project, Task.project_id == Project.id).where(Project.active.is_(True))
    if project:
        query = query.where(Project.code == project.upper())
    with database.SessionLocal() as session:
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
    tasks.sort(key=lambda t: (t["project"], t["deadline"] is None, t["deadline"] or "", t["id"]))
    return {"today": today.isoformat(), "count": len(tasks), "tasks": tasks}


class _Turn:
    """Tool state for one chat turn: the access mode and what the agent wrote or proposed."""

    def __init__(self, mode: AccessMode):
        self.mode = mode
        self.proposed: dict[str, ProposedEdit] = {}  # by path; a later proposal replaces an earlier one
        self.written: list[str] = []

    def write_note(self, path: str, content: str, frontmatter: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.mode is AccessMode.READ_ONLY:
            raise ToolError("Notes are read only in this conversation")
        rel = file_layer.resolve_note_path(path).relative_to(file_layer.notes_root()).as_posix()
        try:
            current = file_layer.read_note(rel)
        except FileNotFoundError:
            current = None
        if frontmatter is None:
            frontmatter = current["frontmatter"] if current else {}
        if not isinstance(frontmatter, dict):
            raise ToolError("frontmatter must be an object")

        try:
            written = file_layer.write_note(rel, content, frontmatter, self.mode, source=AGENT_SOURCE)
        except file_layer.ApprovalRequiredError:
            if current is not None and (current["content"], current["frontmatter"]) == (content, frontmatter):
                return {"status": "unchanged", "path": rel}
            self.proposed[rel] = ProposedEdit(
                path=rel,
                content=content,
                frontmatter=frontmatter,
                previous_content=current["content"] if current else None,
                previous_frontmatter=current["frontmatter"] if current else None,
                base_hash=file_layer.note_hash(rel),
            )
            return {"status": "proposed", "path": rel, "message": "Waiting for the user's approval in the chat"}
        if written and rel not in self.written:
            self.written.append(rel)
        return {"status": "written" if written else "unchanged", "path": rel}

    def call(self, name: str, arguments: dict[str, Any]) -> Any:
        tools: dict[str, Callable[..., Any]] = {
            "search_notes": search_notes,
            "read_note": read_note,
            "list_tasks": list_tasks,
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
    messages: Sequence[ChatMessage], access_mode: AccessMode, *, settings: Settings | None = None
) -> ChatResponse:
    """Answer the last user message, calling tools as the model asks, for up to `MAX_TOOL_ROUNDS` rounds."""
    settings = settings or get_settings()
    if settings.gemini_api_key is None:
        raise AgentNotConfiguredError("COPILOT_GEMINI_API_KEY is not set; add it to backend/.env")

    mode = AccessMode(access_mode)
    write_rules = _WRITE_RULES[mode] + ("" if mode is AccessMode.READ_ONLY else _WRITE_GUIDE)
    system = SYSTEM_PROMPT.format(today=date.today().isoformat(), write_rules=write_rules)
    history: list[Any] = [{"role": "system", "content": system}]
    history += [{"role": m.role.value, "content": m.content} for m in messages]
    turn, summaries = _Turn(mode), []

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
