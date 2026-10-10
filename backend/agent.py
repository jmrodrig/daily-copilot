"""Co-pilot chat agent: an LLM (via litellm) with tools over the notes and the task database.

Everything the agent sees is limited to the active space: its `content/` notes and its tasks.

The tools the model may call:

- `search_notes`: keyword search across the space's markdown notes.
- `read_note`: read one note with its front-matter.
- `list_tasks`: the space's tasks from SQLite (status, dates, overdue flag).
- `write_note`: create or replace a note. Only offered outside `read_only` mode.
- `search_local_files` / `list_local_directory` / `read_local_file`: search, crawl and read the local file system
  (design data such as PDFs, CAD and Maxsurf files outside the notes; see `local_files`).
- `search_web` / `fetch_web_page`: search the live web (DuckDuckGo) and read web pages, for online research.

Models named in `CLAUDE_CLI_MODELS` and `GEMINI_CLI_MODELS` don't go through litellm: the turn runs on the
local `claude` CLI (Claude Code, signed in with the user's subscription) or the local `gemini` CLI (signed in with
the user's Google account), never with an API key, using the CLI's own file and web tools. Both write notes by
putting `<write_note path="...">` blocks in their reply (see `_run_claude_cli` and `_run_gemini_cli`).

Context injected into the system prompt (see `space_context`):

- the contents of every folder marked as Reference Data in the space;
- when the user has a note open inside a Project folder, that project's open tasks
  (and the tasks linked to the note);
- the local RAG folders configured for the space (Space Preferences), with what's at their top level.

`stream_chat` runs the same turn as `run_chat` but yields live events (thoughts, tool calls starting and ending,
reply text) as they happen, for `POST /api/chat/stream`; a `StreamCancel` stops it and kills the CLI it runs.

Writes go through `file_layer.write_note`, which enforces the access mode and records
every change in `history`. In `ask_first` mode the file layer refuses the write with
`ApprovalRequiredError`; the agent turns that into a `ProposedEdit` for the user to
approve (see `POST /api/notes/apply-edit`).
"""

import functools
import glob
import json
import os
import re
import shutil
import subprocess
import threading
import urllib.parse
import urllib.request
from collections.abc import Callable, Generator, Iterator, Sequence
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import litellm
import yaml
from sqlalchemy import func, or_, select

import database
import file_layer
import local_files
import spaces
from config import Settings, get_settings
from models import FolderMeta, Project, Space, Task
from schemas import AccessMode, ChatMessage, ChatResponse, ProposedEdit, Status, ToolCallSummary, clean_rag_folders

# History sources: the agent writing by itself, and the user approving a proposed edit.
AGENT_SOURCE = "copilot_agent"
APPROVED_SOURCE = "copilot_agent_approved"

MAX_TOOL_ROUNDS = 16
SEARCH_LIMIT = 10
READ_LIMIT = 20_000  # characters of note content returned to the model
_SNIPPET_RADIUS = 80
REFERENCE_LIMIT = 40_000  # characters of Reference Data notes put into the system prompt
CONTEXT_TASK_LIMIT = 50  # project tasks put into the system prompt

# Claude models run on the local `claude` CLI (the user's Claude subscription, no API key): chat name -> CLI model.
CLAUDE_CLI_MODELS: dict[str, str] = {
    "claude-opus-5-5": "opus",
    "claude-sonnet-5-5": "sonnet",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5": "haiku",
}
CLAUDE_CLI_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch"
CLAUDE_CLI_TIMEOUT_SECONDS = 900
CLI_TASK_LIMIT = 200  # open tasks put into the CLI prompt

# Gemini models run on the local `gemini` CLI (the user's Google sign-in, no API key): chat name -> CLI model.
GEMINI_CLI_MODELS: dict[str, str] = {
    "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-pro-preview": "gemini-3-pro-preview",
    "gemini-3.8-flash": "gemini-3.8-flash",
    "gemini-3.5-flash": "gemini-3.5-flash",
    "gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
}
GEMINI_CLI_TIMEOUT_SECONDS = 900
GEMINI_CLI_PROMPT = "Follow the system instructions and answer the latest user message in the conversation above."
# What the Gemini CLI prints when it has no usable Google sign-in.
_GEMINI_AUTH_MARKERS = ("Authentication cancelled", "Opening authentication page", "Please set an Auth method")

# Online research: DuckDuckGo's HTML results page, and plain page fetches.
WEB_SEARCH_URL = "https://html.duckduckgo.com/html/"
WEB_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
_WEB_TIMEOUT_SECONDS = 10
_WEB_MAX_BYTES = 5 * 1024 * 1024


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
- You can search the local file system with `search_local_files`, crawl it with `list_local_directory` and read \
files with `read_local_file` to find design data outside the notes (PDF drawings and reports, CAD files, Maxsurf \
models, spreadsheets, ...). To find files on a topic, start with `search_local_files` on the root folder rather than \
browsing folder by folder. Use absolute paths, e.g. ones linked from a note (`file:///C:/...`, `C:\\...`, \
`\\\\server\\share\\...`). Text and PDF files can be read; for other formats you get only their size and dates. \
Cite the file paths you relied on.
- You can search the live internet with `search_web` and read web pages with `fetch_web_page` for online technical \
research: standards, classification rules, vendor and product data, papers and publications. Search first, then \
read the most relevant pages. Cite the URLs you relied on.
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
_LOCAL_PATH_PARAM = {
    "type": "string",
    "description": "Absolute local path or `file://` URL, e.g. `C:\\Projects\\C7801` or `/home/user/projects`",
}

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
        "completion and an `overdue` flag. Finished and archived tasks are left out unless `include_done` is true.",
        "parameters": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Optional project code or project folder, e.g. C7801"},
                "overdue_only": {"type": "boolean", "description": "Only tasks past their deadline"},
                "include_done": {"type": "boolean", "description": "Also list finished and archived tasks"},
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
    "search_local_files": {
        "description": "Recursively search a local directory tree for files and subfolders whose names match a "
        "keyword or glob pattern (e.g. `scantling`, `*.xlsx`, `lines plan`). Much faster than browsing folder by "
        "folder with list_local_directory.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The root folder to search in, e.g. `O:\\Lawrences Files` or `Y:\\`",
                },
                "query": {
                    "type": "string",
                    "description": "Keywords (all must be in the name) or a glob pattern to match file and folder names",
                },
            },
            "required": ["path", "query"],
        },
    },
    "list_local_directory": {
        "description": "List the files and subfolders (name, type, size in bytes) of a folder on the local file system.",
        "parameters": {"type": "object", "properties": {"path": _LOCAL_PATH_PARAM}, "required": ["path"]},
    },
    "read_local_file": {
        "description": "Read a file on the local file system: text files (.txt, .md, .csv, .json, ...) as they are and "
        "the text of PDFs; other formats (Word, Excel, CAD, Maxsurf, ...) return only their size and dates.",
        "parameters": {"type": "object", "properties": {"path": _LOCAL_PATH_PARAM}, "required": ["path"]},
    },
    "search_web": {
        "description": "Search the live web. Returns up to 10 results with title, URL and snippet; read the useful "
        "ones with fetch_web_page.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Search terms, e.g. `ISO 12215-5 scantlings`"}},
            "required": ["query"],
        },
    },
    "fetch_web_page": {
        "description": "Fetch a web page (http or https) and return its title and readable text.",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "The page URL, e.g. `https://www.iso.org/...`"}},
            "required": ["url"],
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
        archived = task.status == Status.ARCHIVED
        overdue = not done and not archived and task.deadline is not None and task.deadline < today
        if ((done or archived) and not include_done) or (overdue_only and not overdue):
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


# --- Web ----------------------------------------------------------------------


def _web_get(url: str) -> tuple[str, str]:
    """(content type, text) of the page at `url`, reading at most `_WEB_MAX_BYTES` of it."""
    request = urllib.request.Request(url, headers={"User-Agent": WEB_USER_AGENT, "Accept-Language": "en"})
    try:
        with urllib.request.urlopen(request, timeout=_WEB_TIMEOUT_SECONDS) as response:
            raw = response.read(_WEB_MAX_BYTES)
            content_type = response.headers.get("Content-Type", "")
            charset = response.headers.get_content_charset()
    except Exception as exc:  # noqa: BLE001 - network, HTTP and TLS errors all go back to the model
        raise ToolError(f"Could not fetch {url}: {exc}") from exc
    try:
        return content_type, raw.decode(charset or "utf-8", errors="replace")
    except LookupError:  # an unknown charset
        return content_type, raw.decode("utf-8", errors="replace")


def _unwrap_redirect(href: str) -> str:
    """The target of a DuckDuckGo redirect link (`//duckduckgo.com/l/?uddg=<url>&rut=...`), else the link itself."""
    if href.startswith("//"):
        href = "https:" + href
    target = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg")
    return target[0] if target else href


class _SearchResultsParser(HTMLParser):
    """The results of a DuckDuckGo HTML page: each `result__a` link and the `result__snippet` after it."""

    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._field: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = (attributes.get("class") or "").split()
        if "result__a" in classes:
            self.results.append({"title": "", "url": _unwrap_redirect(attributes.get("href") or ""), "snippet": ""})
            self._field = "title"
        elif "result__snippet" in classes and self.results:
            self._field = "snippet"

    def handle_endtag(self, tag: str) -> None:
        if tag in ("a", "td", "div"):
            self._field = None

    def handle_data(self, data: str) -> None:
        if self._field:
            self.results[-1][self._field] += data


def search_web(query: str) -> dict[str, Any]:
    if not query.strip():
        raise ToolError("query must not be empty")
    _content_type, page = _web_get(f"{WEB_SEARCH_URL}?{urllib.parse.urlencode({'q': query})}")
    parser = _SearchResultsParser()
    parser.feed(page)
    results = []
    for result in parser.results:
        url = result["url"]
        if not url.startswith(("http://", "https://")) or "duckduckgo.com/y.js" in url:  # DuckDuckGo's ads
            continue
        results.append(
            {"title": " ".join(result["title"].split()), "url": url, "snippet": " ".join(result["snippet"].split())}
        )
        if len(results) == SEARCH_LIMIT:
            break
    return {"query": query, "results": results}


class _PageTextParser(HTMLParser):
    """The title and readable text of an HTML page, without scripts, styles, navigation and markup."""

    _SKIP = {"script", "style", "noscript", "svg", "template", "nav", "footer", "aside"}
    _BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "pre"}

    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.parts: list[str] = []
        self._skipping = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skipping += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP:
            self._skipping = max(self._skipping - 1, 0)
        elif tag == "title":
            self._in_title = False
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skipping:
            return
        if self._in_title:
            self.title += data
        else:
            self.parts.append(data)


def _readable(text: str) -> str:
    """`text` with the whitespace of each line collapsed and blank lines dropped."""
    lines = (" ".join(line.split()) for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def fetch_web_page(url: str) -> dict[str, Any]:
    url = url.strip()
    if not re.match(r"https?://", url, re.IGNORECASE):
        raise ToolError("Only http:// and https:// URLs can be fetched")
    content_type, page = _web_get(url)
    if not content_type or "html" in content_type:
        parser = _PageTextParser()
        parser.feed(page)
        title, text = " ".join(parser.title.split()), _readable("".join(parser.parts))
    elif content_type.startswith("text/") or "json" in content_type or "xml" in content_type:
        title, text = "", _readable(page)
    else:
        raise ToolError(f"{url} is not a web page ({content_type.split(';')[0]}); only HTML and text can be read")
    if len(text) > READ_LIMIT:
        text = text[:READ_LIMIT] + f"\n\n[… truncated, {len(text)} characters in total]"
    return {"url": url, "title": title, "content": text}


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


def _rag_block(folders: list[str]) -> str:
    """The space's local folders, named only: listing them on every turn would bloat the prompt, so the agent
    crawls them with the local-file tools when a command or question calls for it."""
    lines = [
        "\n\nConfigured Local Folders in this space (crawled when instructed via commands or query, using "
        "`search_local_files`, `list_local_directory` and `read_local_file`):"
    ]
    for folder in folders:
        lines.append(f"- `{folder}`")
    return "\n".join(lines)


def space_context(space_id: int, note_path: str | None = None) -> tuple[str, str]:
    """(space name, extra system prompt text) for a chat in `space_id` with `note_path` open."""
    root = spaces.content_dir(space_id)
    with database.SessionLocal() as session:
        space = session.get(Space, space_id)
        rag_folders = clean_rag_folders(space.rag_folders) if space else []
        metas = spaces.folder_metas(session, space_id)
        project_meta = spaces.project_folder_for(metas, note_path) if note_path else None
        project = session.get(Project, project_meta.project_id) if project_meta and project_meta.project_id else None
        linked_ids = (
            list(session.scalars(select(Task.id).where(Task.space_id == space_id, Task.note_path == note_path)))
            if note_path
            else []
        )
    name = space.name if space else spaces.DEFAULT_SPACE_NAME
    blocks = []

    references = sorted(path for path, meta in metas.items() if meta.is_reference and (root / path).is_dir())
    if references:
        blocks.append(_reference_block(root, references))

    if rag_folders:
        blocks.append(_rag_block(rag_folders))

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
            "search_local_files": local_files.search_local_files,
            "list_local_directory": local_files.list_local_directory,
            "read_local_file": local_files.read_local_file,
            "search_web": search_web,
            "fetch_web_page": fetch_web_page,
        }
        if name not in tools or (name == "write_note" and self.mode is AccessMode.READ_ONLY):
            raise ToolError(f"Unknown tool: {name}")
        try:
            return tools[name](**arguments)
        except TypeError as exc:
            raise ToolError(f"Bad arguments for {name}: {exc}") from exc
        except (file_layer.FileLayerError, local_files.LocalFileError, OSError, UnicodeDecodeError) as exc:
            raise ToolError(str(exc)) from exc


# --- Models -------------------------------------------------------------------


def bare_model_name(model: str | None) -> str:
    """A model name without its provider prefixes (`gemini/`, `claude/`, `models/`), e.g. `gemini-2.5-pro`."""
    name = (model or "").strip()
    while name.startswith(("gemini/", "claude/", "models/")):
        name = name.split("/", 1)[1]
    return name


def is_claude_cli_model(model: str | None) -> bool:
    """Whether `model` (e.g. `claude-opus-5-5` or `claude/claude-opus-4-6`) runs on the local Claude CLI."""
    return bare_model_name(model) in CLAUDE_CLI_MODELS


def is_gemini_cli_model(model: str | None) -> bool:
    """Whether `model` (e.g. `gemini-2.5-pro` or `gemini/gemini-2.5-pro`) runs on the local Gemini CLI."""
    return bare_model_name(model) in GEMINI_CLI_MODELS


def list_models(settings: Settings | None = None) -> list[str]:
    """The models the chat can use (bare names): the configured one first, then the Claude CLI models, then the
    Gemini CLI ones. They all run on a local CLI, so no API key is needed to list or use them."""
    settings = settings or get_settings()
    configured = bare_model_name(settings.chat_model)
    return list(dict.fromkeys([configured, *CLAUDE_CLI_MODELS, *GEMINI_CLI_MODELS]))


def chat_model_id(model: str | None, settings: Settings) -> str:
    """The litellm model string for a model picked in the chat that runs on neither CLI (a Gemini API one), or
    the configured default."""
    if not model or not model.strip():
        return settings.chat_model
    model = model.strip().removeprefix("models/")
    return model if model.startswith("gemini/") else f"gemini/{model}"


# --- Chat loop ----------------------------------------------------------------


def _shown_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    # Note bodies are shown as proposed edits, not repeated in the tool call list.
    return {k: v for k, v in arguments.items() if k != "content"}


def _summary(name: str, arguments: dict[str, Any], ok: bool) -> ToolCallSummary:
    return ToolCallSummary(name=name, arguments=_shown_arguments(arguments), ok=ok)


# A live event of a streamed turn (see `stream_chat`).
Event = dict[str, Any]


def _tool_start(call_id: str, name: str, arguments: dict[str, Any]) -> Event:
    return {"type": "tool_start", "id": call_id, "name": name, "arguments": _shown_arguments(arguments)}


def _tool_end(call_id: str, name: str, ok: bool) -> Event:
    return {"type": "tool_end", "id": call_id, "name": name, "ok": ok}


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


FINAL_ANSWER_PROMPT = (
    "You have reached the tool call limit. Based on all the files, notes, and data you have gathered so far, "
    "synthesize and provide your complete, detailed final answer now."
)


def _fallback_reply(summaries: Sequence[ToolCallSummary]) -> str:
    """What to show when the model gives no text at all: which tools it ran, so the user can ask again."""
    if not summaries:
        return "(The model returned no answer.)"
    lines = [
        f"- `{s.name}` {json.dumps(s.arguments, ensure_ascii=False)}" + ("" if s.ok else " (failed)") for s in summaries
    ]
    return "The model stopped without writing an answer. It had looked at:\n" + "\n".join(lines)


# --- Local CLIs (Claude, Gemini) ----------------------------------------------


_CLI_TOOLS_GUIDE = """
Tools in this session: you run inside Claude Code with the tools Read, Glob, Grep, WebSearch and WebFetch, not the \
tools named above. Map them as follows:
- The space's notes are the markdown files under `{notes_dir}` (paths in this prompt are relative to it): find them \
with Glob and Grep and read them with Read, instead of `search_notes` and `read_note`.
- Local design files (instead of `search_local_files`, `list_local_directory`, `read_local_file`): Glob, Grep and \
Read with absolute paths.
- Online research (instead of `search_web`, `fetch_web_page`): WebSearch and WebFetch. Cite the URLs you relied on.
- The space's open tasks are listed below (instead of `list_tasks`)."""

_GEMINI_TOOLS_GUIDE = """
Tools in this session: you run inside the Gemini CLI with its own tools, not the tools named above. Use only its \
read and research tools, mapped as follows:
- The space's notes are the markdown files under `{notes_dir}` (paths in this prompt are relative to it): find them \
with glob and grep_search and read them with read_file, instead of `search_notes` and `read_note`.
- Local design files (instead of `search_local_files`, `list_local_directory`, `read_local_file`): glob, \
grep_search, list_directory and read_file with absolute paths.
- Online research (instead of `search_web`, `fetch_web_page`): google_web_search and web_fetch. Cite the URLs you \
relied on.
- The space's open tasks are listed below (instead of `list_tasks`).
- Never use write_file, replace or run_shell_command."""

_CLI_WRITE_PROTOCOL = """
- Do NOT use Write or Edit tools on files directly. To create or update a note in this space, include a \
`<write_note path="relative/path.md">` block containing the full markdown content (with optional YAML front-matter) \
in your response, e.g.:
<write_note path="C7801/Report.md">
---
type: report
---
# Heading
...
</write_note>
The Co-pilot app will automatically process this block according to the active access mode (proposing a diff card \
for user approval in ASK FIRST mode, or saving it in WRITE DIRECTLY mode). The block replaces the whole note: to \
edit one, Read it first and send its full new content. Without front-matter, an existing note keeps its own."""

_CLI_WRITE_RULES = {
    AccessMode.READ_ONLY: _WRITE_RULES[AccessMode.READ_ONLY],
    AccessMode.ASK_FIRST: "- You are in ASK FIRST mode: a `<write_note>` block only proposes the change; the user "
    "approves or rejects it in the chat. Tell the user the edit is waiting for their approval." + _CLI_WRITE_PROTOCOL,
    AccessMode.WRITE_DIRECTLY: "- You are in WRITE DIRECTLY mode: a `<write_note>` block saves the note immediately. "
    "Tell the user which note you wrote." + _CLI_WRITE_PROTOCOL,
}

_WRITE_NOTE_BLOCK = re.compile(r"<write_note\s+path\s*=\s*\"([^\"]+)\"\s*>\r?\n?(.*?)</write_note>", re.DOTALL)
_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


def _cli_prompt(
    messages: Sequence[ChatMessage],
    mode: AccessMode,
    turn: "_Turn",
    space_id: int,
    note_path: str | None,
    tools_guide: str = _CLI_TOOLS_GUIDE,
) -> str:
    """Everything a CLI gets on stdin: the system prompt (with `tools_guide`, how the CLI's own tools stand in for
    ours), the space's notes folder and tasks, and the chat."""
    space_name, context = space_context(space_id, note_path)
    system = SYSTEM_PROMPT.format(
        today=date.today().isoformat(), write_rules=_CLI_WRITE_RULES[mode], space_name=space_name, context=context
    )
    tasks = list_tasks(space_id=space_id)["tasks"]
    task_lines = [_task_line({**t, "title": f"[{t['project'] or 'no project'}] {t['title']}"}) for t in tasks]
    if len(tasks) > CLI_TASK_LIMIT:
        task_lines = [*task_lines[:CLI_TASK_LIMIT], f"… and {len(tasks) - CLI_TASK_LIMIT} more."]
    conversation = "\n\n".join(f"<{m.role.value}>\n{m.content}\n</{m.role.value}>" for m in messages)
    return (
        f"<system>\n{system}\n{tools_guide.format(notes_dir=turn.root.resolve())}\n</system>\n\n"
        f"<open_tasks today=\"{date.today().isoformat()}\" count=\"{len(tasks)}\">\n"
        + ("\n".join(task_lines) or "(no open tasks)")
        + f"\n</open_tasks>\n\n<conversation>\n{conversation}\n</conversation>\n\n"
        "Answer the last user message of the conversation."
    )


def _cli_folders(turn: "_Turn") -> list[str]:
    """The space's local RAG folders that exist, opened to a CLI next to the notes folder."""
    with database.SessionLocal() as session:
        space = session.get(Space, turn.space_id)
        rag_folders = clean_rag_folders(space.rag_folders) if space else []
    return [folder for folder in rag_folders if Path(folder).is_dir()]


def _cli_command(claude_bin: str, model: str, turn: "_Turn", reasoning_effort: str | None) -> list[str]:
    cmd = [
        claude_bin,
        "-p",
        "--model",
        CLAUDE_CLI_MODELS[model],
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--tools",
        CLAUDE_CLI_TOOLS,
        "--add-dir",
        str(turn.root.resolve()),
    ]
    for folder in _cli_folders(turn):
        cmd += ["--add-dir", folder]
    if reasoning_effort in ("low", "medium", "high"):
        cmd += ["--effort", reasoning_effort]
    return cmd


class _StreamState:
    """What a CLI's stream-json output has said so far: its tool calls, reply, result and errors."""

    def __init__(self) -> None:
        self.calls: dict[str, tuple[str, dict[str, Any], bool]] = {}  # by tool call id: (name, arguments, ok)
        self.parts: list[str] = []  # the Gemini reply, in delta chunks
        self.result: str | None = None  # the Claude reply
        self.is_error = False
        self.error: str | None = None
        self.needs_sign_in = False

    def summaries(self) -> list[ToolCallSummary]:
        return [_summary(name, arguments, ok) for name, arguments, ok in self.calls.values()]

    def start_call(self, call_id: str, name: str, arguments: dict[str, Any]) -> Event:
        self.calls[call_id] = (name, arguments, True)
        return _tool_start(call_id, name, arguments)

    def end_call(self, call_id: str, ok: bool) -> Event:
        name, arguments, _ok = self.calls[call_id]
        self.calls[call_id] = (name, arguments, ok)
        return _tool_end(call_id, name, ok)


def _json_line(line: str) -> dict[str, Any] | None:
    try:
        event = json.loads(line)
    except ValueError:
        return None
    return event if isinstance(event, dict) else None


def _claude_events(line: str, state: _StreamState) -> list[Event]:
    """The live events for one line of the Claude CLI's stream-json output, which is recorded in `state`."""
    event = _json_line(line)
    if event is None:
        return []
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    items = [item for item in content if isinstance(item, dict)] if isinstance(content, list) else []
    events: list[Event] = []
    if event.get("type") == "assistant":
        for item in items:
            if item.get("type") == "thinking" and isinstance(item.get("thinking"), str) and item["thinking"].strip():
                events.append({"type": "thought", "subject": None, "text": item["thinking"].strip()})
            elif item.get("type") == "text" and isinstance(item.get("text"), str) and item["text"]:
                events.append({"type": "text_delta", "delta": item["text"]})
            elif item.get("type") == "tool_use":
                arguments = item.get("input") if isinstance(item.get("input"), dict) else {}
                events.append(state.start_call(str(item.get("id")), str(item.get("name")), arguments))
    elif event.get("type") == "user":
        for item in items:
            if item.get("type") == "tool_result" and str(item.get("tool_use_id")) in state.calls:
                events.append(state.end_call(str(item.get("tool_use_id")), not item.get("is_error", False)))
    elif event.get("type") == "result":
        state.result = event.get("result") if isinstance(event.get("result"), str) else None
        state.is_error = bool(event.get("is_error"))
    return events


def _parse_stream(stdout: str) -> tuple[str | None, bool, list[ToolCallSummary]]:
    """(final result text, whether it is an error, the tool calls made) from the CLI's stream-json output."""
    state = _StreamState()
    for line in stdout.splitlines():
        _claude_events(line, state)
    return state.result, state.is_error, state.summaries()


def _claude_env() -> dict[str, str]:
    """The Claude CLI's environment: without an API key in it, the CLI uses the subscription it is signed in with."""
    return {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}


def _apply_write_blocks(reply: str, turn: "_Turn") -> tuple[str, list[ToolCallSummary]]:
    """Carry out the `<write_note>` blocks of `reply` through `turn` and return the reply without them."""
    summaries, notes = [], []
    for match in _WRITE_NOTE_BLOCK.finditer(reply):
        path, body = match.group(1).strip(), match.group(2)
        frontmatter = None
        header = _FRONTMATTER.match(body)
        if header:
            try:
                parsed = yaml.safe_load(header.group(1))
            except yaml.YAMLError:
                parsed = None
            if isinstance(parsed, dict) or parsed is None:
                frontmatter, body = parsed or {}, body[header.end() :]
        try:
            result = turn.write_note(path, body.strip("\r\n"), frontmatter)
        except (ToolError, file_layer.FileLayerError, OSError) as exc:
            ok = False
            notes.append(f"Could not write `{path}`: {exc}")
        else:
            ok = True
            notes.append(
                {
                    "proposed": f"Proposed an edit to `{result['path']}`; it is waiting for your approval.",
                    "written": f"Wrote `{result['path']}`.",
                    "unchanged": f"`{result['path']}` is unchanged.",
                }[result["status"]]
            )
        summaries.append(_summary("write_note", {"path": path}, ok))
    if not summaries:
        return reply, []
    cleaned = re.sub(r"\n{3,}", "\n\n", _WRITE_NOTE_BLOCK.sub("", reply)).strip()
    failed = [note for note, summary in zip(notes, summaries) if not summary.ok]
    if not cleaned:
        cleaned = "\n".join(f"- {note}" for note in notes)
    elif failed:
        cleaned += "\n\n" + "\n".join(f"- {note}" for note in failed)
    return cleaned, summaries


def _cli_response(reply: str, summaries: Sequence[ToolCallSummary], turn: "_Turn") -> ChatResponse:
    """A CLI turn's response: its reply with the `<write_note>` blocks carried out, after the tool calls it made."""
    reply, writes = _apply_write_blocks(reply, turn)  # refused in read only mode, with a note in the reply
    tool_calls = [*summaries, *writes]
    return ChatResponse(
        reply=reply.strip() or _fallback_reply(tool_calls),
        proposed_edits=list(turn.proposed.values()),
        written_paths=turn.written,
        tool_calls=tool_calls,
    )


def _claude_reply(result: str | None, is_error: bool, stderr: str, returncode: int | None) -> str:
    if result is None or is_error:
        detail = (result or stderr.strip() or f"exit code {returncode}")[-2000:]
        raise AgentError(f"The Claude CLI failed: {detail}")
    return result


def _terminate_process(process: "subprocess.Popen[str]") -> None:
    """Kill `process` if it still runs, with its children: on Windows a CLI is a `.cmd` whose `node.exe` outlives a
    plain kill of cmd.exe."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
    else:
        process.terminate()
    try:
        process.kill()
    except OSError:
        pass  # already gone


class StreamCancel:
    """Stops a `stream_chat` turn from another thread: `cancel()` kills the CLI it runs at once, and the turn then
    ends without a `done` event."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self.cancelled = False

    def attach(self, process: "subprocess.Popen[str]") -> None:
        with self._lock:
            self._process, cancelled = process, self.cancelled
        if cancelled:
            _terminate_process(process)

    def cancel(self) -> None:
        with self._lock:
            self.cancelled, process = True, self._process
        if process is not None:
            _terminate_process(process)


def _feed(stdin: Any, prompt: str) -> None:
    try:
        stdin.write(prompt)
        stdin.close()
    except OSError:
        pass  # the CLI exited (or was killed) before reading it all


def _cli_lines(
    cmd: list[str], prompt: str, *, cwd: Path, env: dict[str, str], timeout: int, name: str, cancel: StreamCancel
) -> Generator[str, None, tuple[str, int | None]]:
    """Run `cmd` with `prompt` on stdin and yield its stdout lines as they come; return (its stderr, its exit code).
    The process is killed when it overruns `timeout` seconds, on `cancel`, and when the caller stops iterating."""
    try:
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=cwd,
            env=env,
        )
    except OSError as exc:
        raise AgentError(f"The {name} could not be started: {exc}") from exc
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    stderr: list[str] = []
    readers = [
        # Separate threads, so neither a long prompt nor a full stderr pipe can stall the CLI.
        threading.Thread(target=_feed, args=(process.stdin, prompt), daemon=True),
        threading.Thread(target=lambda: stderr.append(process.stderr.read()), daemon=True),  # type: ignore[union-attr]
    ]
    timed_out = threading.Event()

    def expire() -> None:
        timed_out.set()
        _terminate_process(process)

    timer = threading.Timer(timeout, expire)
    timer.daemon = True
    try:
        for thread in readers:
            thread.start()
        timer.start()
        cancel.attach(process)
        yield from iter(process.stdout.readline, "")
        process.wait()
        readers[1].join()
    finally:
        timer.cancel()
        _terminate_process(process)
    if timed_out.is_set():
        raise AgentError(f"The {name} did not answer within {timeout} seconds")
    return "".join(stderr), process.returncode


def _finish_cli_turn(response: ChatResponse, cli_calls: int) -> Iterator[Event]:
    """The events closing a streamed CLI turn: the `<write_note>` blocks carried out after its `cli_calls` own
    tool calls, then `done`."""
    for i, write in enumerate(response.tool_calls[cli_calls:]):
        yield _tool_start(f"write_note-{i}", write.name, write.arguments)
        yield _tool_end(f"write_note-{i}", write.name, write.ok)
    yield {"type": "done", "response": response.model_dump(mode="json")}


def _run_claude_cli(
    messages: Sequence[ChatMessage],
    mode: AccessMode,
    *,
    space_id: int,
    note_path: str | None,
    model: str,
    reasoning_effort: str | None,
) -> ChatResponse:
    """Answer on the local `claude` CLI (`model` is a `CLAUDE_CLI_MODELS` key), which uses the user's signed-in
    Claude subscription: no API key needed. The prompt goes on stdin, as on Windows `claude` is a `.cmd` run by
    cmd.exe, whose command line is limited to 8,191 characters and can't hold newlines."""
    claude_bin = shutil.which("claude")
    if claude_bin is None:
        raise AgentNotConfiguredError("Claude CLI (`claude`) is not installed or not on PATH")
    turn = _Turn(mode, space_id)
    prompt = _cli_prompt(messages, mode, turn, space_id, note_path)
    try:
        process = subprocess.run(
            _cli_command(claude_bin, model, turn, reasoning_effort),
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=turn.root,
            env=_claude_env(),
            timeout=CLAUDE_CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise AgentError(f"The Claude CLI did not answer within {CLAUDE_CLI_TIMEOUT_SECONDS} seconds") from exc
    except OSError as exc:
        raise AgentError(f"The Claude CLI could not be started: {exc}") from exc

    result, is_error, summaries = _parse_stream(process.stdout or "")
    return _cli_response(_claude_reply(result, is_error, process.stderr or "", process.returncode), summaries, turn)


def _stream_claude_cli(
    messages: Sequence[ChatMessage],
    mode: AccessMode,
    *,
    space_id: int,
    note_path: str | None,
    model: str,
    reasoning_effort: str | None,
    cancel: StreamCancel,
) -> Iterator[Event]:
    """`_run_claude_cli`, yielding the CLI's thoughts, tool calls and text as it outputs them."""
    claude_bin = shutil.which("claude")
    if claude_bin is None:
        raise AgentNotConfiguredError("Claude CLI (`claude`) is not installed or not on PATH")
    turn = _Turn(mode, space_id)
    prompt = _cli_prompt(messages, mode, turn, space_id, note_path)
    state = _StreamState()
    lines = _cli_lines(
        _cli_command(claude_bin, model, turn, reasoning_effort),
        prompt,
        cwd=turn.root,
        env=_claude_env(),
        timeout=CLAUDE_CLI_TIMEOUT_SECONDS,
        name="Claude CLI",
        cancel=cancel,
    )
    stderr, returncode = yield from _line_events(lines, _claude_events, state)
    if cancel.cancelled:
        return
    response = _cli_response(_claude_reply(state.result, state.is_error, stderr, returncode), state.summaries(), turn)
    yield from _finish_cli_turn(response, len(state.calls))


def _line_events(
    lines: Generator[str, None, tuple[str, int | None]],
    parse: Callable[[str, _StreamState], list[Event]],
    state: _StreamState,
) -> Generator[Event, None, tuple[str, int | None]]:
    """The live events `parse` finds in a CLI's output `lines`; return what `lines` returns."""
    try:
        while True:
            try:
                line = next(lines)
            except StopIteration as stop:
                return stop.value
            yield from parse(line, state)
    finally:
        lines.close()  # kills the CLI if the caller stopped early


def _gemini_command(gemini_bin: str, model: str, turn: "_Turn") -> list[str]:
    cmd = [
        gemini_bin,
        "-p",
        GEMINI_CLI_PROMPT,
        "-m",
        GEMINI_CLI_MODELS[model],
        "-o",
        "stream-json",
        "--skip-trust",
        "--yolo",
        "--include-directories",
        str(turn.root.resolve()),
    ]
    for folder in _cli_folders(turn):
        cmd += ["--include-directories", folder]
    return cmd


def _gemini_env() -> dict[str, str]:
    """The Gemini CLI's environment: no API keys, and Google sign-in forced, so it never bills an API key."""
    env = {k: v for k, v in os.environ.items() if k not in ("GEMINI_API_KEY", "GOOGLE_API_KEY")}
    env["GOOGLE_GENAI_USE_GCA"] = "true"
    return env


def _gemini_events(line: str, state: _StreamState) -> list[Event]:
    """The live events for one line of the Gemini CLI's stream-json output, which is recorded in `state`."""
    if any(marker in line for marker in _GEMINI_AUTH_MARKERS):
        state.needs_sign_in = True
    event = _json_line(line)
    if event is None:
        return []
    kind = event.get("type")
    if kind == "thought":
        subject = event.get("subject")
        text = str(event.get("description") or "")
        return [{"type": "thought", "subject": subject if isinstance(subject, str) else None, "text": text}]
    if kind == "message" and event.get("role") == "assistant":
        # Delta messages are chunks of one reply, in order.
        if isinstance(event.get("content"), str) and event["content"]:
            state.parts.append(event["content"])
            return [{"type": "text_delta", "delta": event["content"]}]
    elif kind == "tool_use":
        arguments = event.get("parameters") if isinstance(event.get("parameters"), dict) else {}
        return [state.start_call(str(event.get("tool_id")), str(event.get("tool_name")), arguments)]
    elif kind == "tool_result" and str(event.get("tool_id")) in state.calls:
        return [state.end_call(str(event.get("tool_id")), event.get("status") != "error")]
    elif kind == "error":
        state.error = str(event.get("message") or "unknown error")
    elif kind == "result" and event.get("status") == "error":
        detail = event.get("error")
        state.error = str((detail.get("message") if isinstance(detail, dict) else detail) or state.error or "unknown error")
    return []


def _parse_gemini_stream(stdout: str) -> tuple[str, str | None, list[ToolCallSummary]]:
    """(reply text, error message if any, the tool calls made) from the Gemini CLI's stream-json output."""
    state = _StreamState()
    for line in stdout.splitlines():
        _gemini_events(line, state)
    return "".join(state.parts), state.error, state.summaries()


def _run_gemini_cli(
    messages: Sequence[ChatMessage],
    mode: AccessMode,
    *,
    space_id: int,
    note_path: str | None,
    model: str,
) -> ChatResponse:
    """Answer on the local `gemini` CLI (`model` is a `GEMINI_CLI_MODELS` key), signed in with the user's Google
    account: API keys are kept out of its environment. As with the Claude CLI, the prompt goes on stdin."""
    gemini_bin = shutil.which("gemini")
    if gemini_bin is None:
        raise AgentNotConfiguredError("Gemini CLI (`gemini`) is not installed or not on PATH")
    turn = _Turn(mode, space_id)
    prompt = _cli_prompt(messages, mode, turn, space_id, note_path, _GEMINI_TOOLS_GUIDE)
    try:
        process = subprocess.run(
            _gemini_command(gemini_bin, model, turn),
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=turn.root,
            env=_gemini_env(),
            timeout=GEMINI_CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise AgentError(f"The Gemini CLI did not answer within {GEMINI_CLI_TIMEOUT_SECONDS} seconds") from exc
    except OSError as exc:
        raise AgentError(f"The Gemini CLI could not be started: {exc}") from exc

    stdout, stderr = process.stdout or "", process.stderr or ""
    reply, error, summaries = _parse_gemini_stream(stdout)
    needs_sign_in = any(marker in stdout for marker in _GEMINI_AUTH_MARKERS)
    _check_gemini(needs_sign_in, error, stderr, process.returncode)
    return _cli_response(reply, summaries, turn)


def _check_gemini(needs_sign_in: bool, error: str | None, stderr: str, returncode: int | None) -> None:
    if needs_sign_in or any(marker in stderr for marker in _GEMINI_AUTH_MARKERS):
        raise AgentNotConfiguredError(
            "Gemini CLI needs a one-time Google sign-in: run `gemini` in a terminal and choose Login with Google."
        )
    if error or returncode != 0:
        detail = (error or stderr.strip() or f"exit code {returncode}")[-2000:]
        raise AgentError(f"The Gemini CLI failed: {detail}")


def _stream_gemini_cli(
    messages: Sequence[ChatMessage],
    mode: AccessMode,
    *,
    space_id: int,
    note_path: str | None,
    model: str,
    cancel: StreamCancel,
) -> Iterator[Event]:
    """`_run_gemini_cli`, yielding the CLI's thoughts, tool calls and reply chunks as it outputs them."""
    gemini_bin = shutil.which("gemini")
    if gemini_bin is None:
        raise AgentNotConfiguredError("Gemini CLI (`gemini`) is not installed or not on PATH")
    turn = _Turn(mode, space_id)
    prompt = _cli_prompt(messages, mode, turn, space_id, note_path, _GEMINI_TOOLS_GUIDE)
    state = _StreamState()
    lines = _cli_lines(
        _gemini_command(gemini_bin, model, turn),
        prompt,
        cwd=turn.root,
        env=_gemini_env(),
        timeout=GEMINI_CLI_TIMEOUT_SECONDS,
        name="Gemini CLI",
        cancel=cancel,
    )
    stderr, returncode = yield from _line_events(lines, _gemini_events, state)
    if cancel.cancelled:
        return
    _check_gemini(state.needs_sign_in, state.error, stderr, returncode)
    yield from _finish_cli_turn(_cli_response("".join(state.parts), state.summaries(), turn), len(state.calls))


def run_chat(
    messages: Sequence[ChatMessage],
    access_mode: AccessMode,
    *,
    space_id: int = spaces.DEFAULT_SPACE_ID,
    note_path: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    settings: Settings | None = None,
) -> ChatResponse:
    """Answer the last user message in `space_id`, calling tools as the model asks, for up to
    `MAX_TOOL_ROUNDS` rounds. `note_path` is the note the user has open, if any; `model` the model picked
    in the chat (else `settings.chat_model`; a Claude or Gemini CLI model runs on the local `claude` or `gemini`
    CLI instead);
    `reasoning_effort` ("low", "medium" or "high") how hard it thinks, left to the model if not given or not
    supported."""
    settings = settings or get_settings()
    chosen = model.strip() if model and model.strip() else settings.chat_model
    if is_claude_cli_model(chosen):
        return _run_claude_cli(
            messages,
            AccessMode(access_mode),
            space_id=space_id,
            note_path=note_path,
            model=bare_model_name(chosen),
            reasoning_effort=reasoning_effort,
        )
    if is_gemini_cli_model(chosen):
        return _run_gemini_cli(
            messages, AccessMode(access_mode), space_id=space_id, note_path=note_path, model=bare_model_name(chosen)
        )
    return _drain(
        _litellm_turn(
            messages,
            AccessMode(access_mode),
            space_id=space_id,
            note_path=note_path,
            model=model,
            reasoning_effort=reasoning_effort,
            settings=settings,
            cancel=StreamCancel(),
        )
    )


def _drain(events: Generator[Event, None, ChatResponse | None]) -> ChatResponse:
    """What a turn's event generator returns, once run to the end."""
    while True:
        try:
            next(events)
        except StopIteration as stop:
            assert stop.value is not None  # only a cancelled turn returns nothing
            return stop.value


def _loose_arguments(raw_arguments: str | None) -> dict[str, Any]:
    """A tool call's arguments for display: {} if they are not a JSON object (`_run_tool` reports why)."""
    try:
        arguments = json.loads(raw_arguments or "{}")
    except ValueError:
        return {}
    return arguments if isinstance(arguments, dict) else {}


def _litellm_turn(
    messages: Sequence[ChatMessage],
    mode: AccessMode,
    *,
    space_id: int,
    note_path: str | None,
    model: str | None,
    reasoning_effort: str | None,
    settings: Settings,
    cancel: StreamCancel,
) -> Generator[Event, None, ChatResponse | None]:
    """A turn on LiteLLM's tool loop, yielding each tool call as it starts and ends; return its response (None if
    cancelled)."""
    if settings.gemini_api_key is None:
        raise AgentNotConfiguredError("COPILOT_GEMINI_API_KEY is not set; add it to backend/.env")

    write_rules = _WRITE_RULES[mode] + ("" if mode is AccessMode.READ_ONLY else _WRITE_GUIDE)
    space_name, context = space_context(space_id, note_path)
    system = SYSTEM_PROMPT.format(
        today=date.today().isoformat(), write_rules=write_rules, space_name=space_name, context=context
    )
    history: list[Any] = [{"role": "system", "content": system}]
    history += [{"role": m.role.value, "content": m.content} for m in messages]
    turn, summaries = _Turn(mode, space_id), []
    chosen_model = chat_model_id(model, settings)

    for round_ in range(MAX_TOOL_ROUNDS + 1):
        if cancel.cancelled:
            return None
        last = round_ == MAX_TOOL_ROUNDS  # Out of rounds: make the model answer with what it has.
        if last:
            # Gemini ignores tool_choice="none" while tools are declared and keeps calling them, so the last
            # round declares no tools at all and asks outright for the answer.
            history.append({"role": "user", "content": FINAL_ANSWER_PROMPT})
        kwargs: dict[str, Any] = {
            "model": chosen_model,
            "api_key": settings.gemini_api_key.get_secret_value(),
            "messages": history,
        }
        if not last:
            kwargs.update(tools=_tool_specs(mode), tool_choice="auto")
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
        try:
            try:
                response = litellm.completion(**kwargs)
            except litellm.UnsupportedParamsError:
                if not reasoning_effort:
                    raise
                # This model can't take an effort level: answer with its own and stop asking for one.
                reasoning_effort = None
                del kwargs["reasoning_effort"]
                response = litellm.completion(**kwargs)
        except Exception as exc:  # litellm raises many provider-specific types
            raise AgentError(f"The chat model failed: {exc}") from exc
        message = response.choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []
        if not tool_calls or last:
            return ChatResponse(
                reply=message.content or getattr(message, "reasoning_content", None) or _fallback_reply(summaries),
                proposed_edits=list(turn.proposed.values()),
                written_paths=turn.written,
                tool_calls=summaries,
            )
        # Keep the provider's message object as is: Gemini needs its thought signatures echoed back.
        history.append(message)
        for call in tool_calls:
            if cancel.cancelled:
                return None
            yield _tool_start(call.id, call.function.name, _loose_arguments(call.function.arguments))
            result, summary = _run_tool(turn, call.function.name, call.function.arguments)
            summaries.append(summary)
            yield _tool_end(call.id, call.function.name, summary.ok)
            history.append({"role": "tool", "tool_call_id": call.id, "name": call.function.name, "content": result})
    raise AssertionError("unreachable")


def stream_chat(
    messages: Sequence[ChatMessage],
    access_mode: AccessMode,
    *,
    space_id: int = spaces.DEFAULT_SPACE_ID,
    note_path: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    settings: Settings | None = None,
    cancel: StreamCancel | None = None,
) -> Iterator[Event]:
    """`run_chat`, yielding what the agent does as it happens: `thought`, `tool_start`, `tool_end` and `text_delta`
    events, then `done` with the `ChatResponse`. Raises `AgentNotConfiguredError` and `AgentError` as `run_chat`
    does. `cancel` stops the turn from another thread; closing the iterator stops it too. Either way the CLI it
    runs is killed."""
    settings = settings or get_settings()
    cancel = cancel or StreamCancel()
    mode = AccessMode(access_mode)
    chosen = model.strip() if model and model.strip() else settings.chat_model
    if is_claude_cli_model(chosen):
        yield from _stream_claude_cli(
            messages,
            mode,
            space_id=space_id,
            note_path=note_path,
            model=bare_model_name(chosen),
            reasoning_effort=reasoning_effort,
            cancel=cancel,
        )
        return
    if is_gemini_cli_model(chosen):
        yield from _stream_gemini_cli(
            messages, mode, space_id=space_id, note_path=note_path, model=bare_model_name(chosen), cancel=cancel
        )
        return
    response = yield from _litellm_turn(
        messages,
        mode,
        space_id=space_id,
        note_path=note_path,
        model=model,
        reasoning_effort=reasoning_effort,
        settings=settings,
        cancel=cancel,
    )
    if response is not None:
        yield {"type": "done", "response": response.model_dump(mode="json")}
