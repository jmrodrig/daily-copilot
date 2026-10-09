"""FastAPI entry point. Run with `uvicorn main:app --reload` from backend/."""

import html
import re
import secrets
import urllib.request
from urllib.parse import quote
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Any

from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

import agent
import file_layer
import database
import local_files
import spaces
from database import get_db, init_db
from history import set_source, soft_delete, to_jsonable, utcnow
from models import FolderMeta, Person, Project, SavedPrompt, Space, Task, TaskView, TimeLog
import schemas
from schemas import (
    AccessMode,
    ApplyEditRequest,
    ApplyEditResponse,
    CaptureRequest,
    CaptureResponse,
    ChatRequest,
    ChatResponse,
    CheckInRequest,
    CheckInResponse,
    ContentEntry,
    ContentKind,
    ContentMove,
    ContentRef,
    ContentRename,
    GanttProject,
    GanttResponse,
    GanttTask,
    FolderCreate,
    ImageUpload,
    LocalFileCheck,
    LocalFileStat,
    LocalPathRequest,
    MediaMarkup,
    FolderMetaOut,
    FolderMetaUpdate,
    FolderOrderUpdate,
    NoteCreate,
    NoteFile,
    NoteRoot,
    NoteState,
    NoteRecent,
    NoteSummary,
    NoteUpdate,
    Priority,
    ProjectOption,
    Status,
    TaskBulkUpdate,
    TaskCommentIn,
    TaskCreate,
    TaskItem,
    TaskUpdate,
    TreeResponse,
    TriageItem,
    TriageKind,
    TriageRank,
    UrlMetadata,
)

INBOX = "Inbox"
CAPTURE_SOURCE = "android_app"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    with database.SessionLocal() as db:
        spaces.migrate(db)
        for space in db.scalars(select(Space)).all():
            seed_prompts(db, space.id)
            seed_views(db, space.id)
    yield


app = FastAPI(title="Daily Co-Pilot Backend", version="0.1.0", lifespan=lifespan)


def _space_id_or_404(db: Session, space_id: int) -> int:
    if spaces.get_space(db, space_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown space id: {space_id}")
    return space_id


def space_content(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> Path:
    """Dependency: the `content/` folder of the `space_id` query parameter (404 for an unknown space)."""
    return spaces.content_dir(_space_id_or_404(db, space_id))


@app.get("/health")
def health() -> dict[str, str]:
    from config import get_settings
    return {"status": "ok", "chat_model": get_settings().chat_model}


@app.get("/api/models")
def models() -> list[str]:
    """The Gemini models the Co-pilot chat can answer with (e.g. `gemini-2.5-pro`), the configured default first."""
    return agent.list_models()


_URL_TIMEOUT_SECONDS = 5
# Enough for the <head> of any page; the title is never further in.
_URL_MAX_BYTES = 512 * 1024
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


@app.get("/api/url-metadata")
def url_metadata(url: str) -> UrlMetadata:
    """The `<title>` of a web page, for a new link pill's display text; `title` is None if it can't be had."""
    if not re.match(r"https?://", url, re.IGNORECASE):
        return UrlMetadata()
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=_URL_TIMEOUT_SECONDS) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            page = response.read(_URL_MAX_BYTES).decode(charset, errors="replace")
    except Exception:  # noqa: BLE001 - any failure (network, HTTP error, bad charset) just means no title
        return UrlMetadata()
    match = _TITLE.search(page)
    title = " ".join(html.unescape(match.group(1)).split()) if match else ""
    return UrlMetadata(title=title or None)


def _capture_path(project: str, now: datetime, root: Path) -> str:
    """`Inbox/Capture_<ts>.md` or `<project>/Notes-in/Capture_<ts>.md`, never an existing file."""
    folder = INBOX if project.lower() == INBOX.lower() else f"{project}/Notes-in"
    stem = f"{folder}/Capture_{now:%Y%m%d_%H%M%S}"
    path, n = f"{stem}.md", 1
    while file_layer.resolve_note_path(path, root).exists():
        n += 1
        path = f"{stem}_{n}.md"
    return path


@app.post("/api/capture")
def capture(request: CaptureRequest, db: Session = Depends(get_db)) -> CaptureResponse:
    """Save a quick note from the Android app as a markdown file in the space's content/."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    now = datetime.now().replace(microsecond=0)
    path = _capture_path(request.project, now, root)
    frontmatter = {
        "type": "capture",
        "project": request.project,
        "priority": request.priority.value,
        "created": now.isoformat(),
    }
    if request.source:
        frontmatter["source"] = request.source.strip().lower()
    # The capture is the user's own new note, so it is written without an approval step.
    file_layer.write_note(
        path, request.content, frontmatter, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=CAPTURE_SOURCE
    )
    return CaptureResponse(path=path)


def _gantt_sort_key(task: Task) -> tuple[bool, date, int]:
    return (task.start_date is None, task.start_date or date.min, task.id)


def _in_space(space_id: int):
    """Filter for the tasks of a space (rows from before Phase 9 count as the Default space)."""
    return func.coalesce(Task.space_id, spaces.DEFAULT_SPACE_ID) == space_id


def _space_projects(db: Session, space_id: int) -> list[Project]:
    """Active projects of a space, by code: those with tasks or a project folder in it.

    A project with neither (e.g. created by a time sheet entry) belongs to the Default space.
    """
    projects = db.scalars(select(Project).where(Project.active.is_(True)).order_by(Project.code)).all()
    homes: dict[int, set[int]] = {}
    task_spaces = select(Task.project_id, func.coalesce(Task.space_id, spaces.DEFAULT_SPACE_ID)).where(
        Task.project_id.is_not(None), Task.deleted_at.is_(None)
    )
    folder_spaces = select(FolderMeta.project_id, FolderMeta.space_id).where(
        FolderMeta.is_project.is_(True), FolderMeta.project_id.is_not(None)
    )
    for project_id, sid in [*db.execute(task_spaces.distinct()), *db.execute(folder_spaces)]:
        homes.setdefault(project_id, set()).add(sid)
    return [p for p in projects if space_id in homes.get(p.id, {spaces.DEFAULT_SPACE_ID})]


@app.get("/api/gantt")
def gantt(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> GanttResponse:
    """Active projects of a space with their shop floor Gantt tasks, for the desktop Gantt chart."""
    projects = _space_projects(db, _space_id_or_404(db, space_id))
    tasks = db.scalars(
        select(Task).where(
            Task.is_gantt_task.is_(True),
            Task.project_id.in_([p.id for p in projects]),
            _in_space(space_id),
            Task.status != Status.ARCHIVED,
        )
    ).all()
    by_project: dict[int, list[Task]] = {p.id: [] for p in projects}
    for task in tasks:
        by_project[task.project_id].append(task)

    return GanttResponse(
        projects=[
            GanttProject(
                id=project.id,
                code=project.code,
                name=project.name,
                color=project.color,
                tasks=[
                    GanttTask(
                        id=task.id,
                        name=task.title,
                        start_date=task.start_date,
                        end_date=task.deadline,
                        completion_percent=task.completion_percent,
                        status=task.status,
                        is_milestone=task.is_milestone,
                        custom_fields=task.custom_fields or {},
                    )
                    for task in sorted(by_project[project.id], key=_gantt_sort_key)
                ],
            )
            for project in projects
        ]
    )


TRIAGE_LOOKAHEAD_DAYS = 7
# Capture notes land in the Inbox or in a project's Notes-in folder (see `_capture_path`).
TRIAGE_NOTE_GLOBS = (f"{INBOX}/*.md", "*/Notes-in/*.md")
_CAPTURE_RANK = {
    Priority.URGENT: TriageRank.CAPTURE_HIGH,
    Priority.HIGH: TriageRank.CAPTURE_HIGH,
    Priority.NORMAL: TriageRank.CAPTURE_NORMAL,
    Priority.LOW: TriageRank.CAPTURE_LOW,
}


def _today() -> date:
    return date.today()


def _gantt_rank(task: Task, today: date) -> TriageRank:
    if task.start_date > today:
        return TriageRank.UPCOMING
    if task.deadline is not None and task.deadline < today:
        return TriageRank.OVERDUE
    return TriageRank.TODAY


def _triage_tasks(db: Session, today: date, space_id: int) -> list[tuple[tuple, TriageItem]]:
    """Unfinished Gantt tasks of active projects that have started or start within the lookahead."""
    rows = db.execute(
        select(Task, Project.code)
        .join(Project, Task.project_id == Project.id)
        .where(
            Project.active.is_(True),
            _in_space(space_id),
            Task.is_gantt_task.is_(True),
            Task.status.not_in([Status.DONE, Status.ARCHIVED]),
            Task.start_date.is_not(None),
            Task.start_date <= today + timedelta(days=TRIAGE_LOOKAHEAD_DAYS),
        )
    ).all()
    items = []
    for task, code in rows:
        if task.completion_percent >= 100:
            continue  # Finished in the imported Gantt even if its status was never set to done.
        item = TriageItem(
            id=f"task:{task.id}",
            kind=TriageKind.GANTT_TASK,
            rank=_gantt_rank(task, today),
            title=task.title,
            project=code,
            priority=task.priority,
            status=task.status,
            assignee=task.assignee,
            start_date=task.start_date,
            due_date=task.deadline,
            note_path=task.note_path,
            tags=task.tags,
        )
        # Earliest deadline first; tasks without one go after those with one.
        key = (task.deadline is None, task.deadline or date.max, task.start_date, task.id)
        items.append((key, item))
    return items


def _note_priority(value: Any) -> Priority:
    try:
        return Priority(str(value).strip().lower())
    except ValueError:
        return Priority.NORMAL


def _note_created(value: Any) -> datetime | None:
    """`created` as a naive local datetime (so notes can be sorted), or None if missing or invalid."""
    if isinstance(value, datetime):
        created = value
    elif isinstance(value, date):
        created = datetime(value.year, value.month, value.day)
    else:
        try:
            created = datetime.fromisoformat(str(value))
        except ValueError:
            return None
    return created.astimezone().replace(tzinfo=None) if created.tzinfo else created


_note_title = spaces.note_title


def _note_project(frontmatter: dict[str, Any], path: str) -> str | None:
    """The front-matter project, falling back to the folder; the Inbox means no project."""
    project = str(frontmatter.get("project") or path.split("/")[0])
    return None if project.lower() == INBOX.lower() else project


def _triage_notes(root: Path) -> list[tuple[tuple, TriageItem]]:
    items = []
    paths = sorted({path for pattern in TRIAGE_NOTE_GLOBS for path in file_layer.list_notes(pattern, notes_dir=root)})
    for path in paths:
        try:
            note = file_layer.read_note(path, notes_dir=root)
        except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
            continue  # A hand-edited note with broken front-matter must not break the whole list.
        frontmatter, content = note["frontmatter"], note["content"]
        priority = _note_priority(frontmatter.get("priority", Priority.NORMAL.value))
        created = _note_created(frontmatter.get("created"))
        item = TriageItem(
            id=f"note:{path}",
            kind=TriageKind.CAPTURE,
            rank=_CAPTURE_RANK[priority],
            title=_note_title(content),
            project=_note_project(frontmatter, path),
            priority=priority,
            created=created,
            path=path,
            content=content,
            tags=frontmatter.get("tags"),
        )
        # Oldest first, so nothing sits at the bottom of a bucket forever; undated notes last.
        key = (created is None, created or datetime.max, path)
        items.append((key, item))
    return items


@app.get("/api/triage")
def triage(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> list[TriageItem]:
    """The Morning List of a space: active Gantt tasks and capture notes, ranked by `TriageRank`."""
    root = spaces.content_dir(_space_id_or_404(db, space_id))
    today = _today()
    ranked = _triage_tasks(db, today, space_id) + _triage_notes(root)
    ranked.sort(key=lambda pair: (pair[1].rank, pair[0]))
    return [item for _key, item in ranked]


TASK_UPDATE_SOURCE = "desktop"


def _get_task(db: Session, task_id: int) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Unknown task id: {task_id}")
    return task


def _check_project(db: Session, project_id: int | None) -> None:
    if project_id is not None:
        project = db.get(Project, project_id)
        if project is None or project.deleted_at is not None:
            raise HTTPException(status_code=400, detail=f"Unknown project id: {project_id}")


def _custom_value(field: schemas.CustomFieldDef, value: Any) -> Any:
    """`value` as stored for a custom field of `field.type`; None clears the field."""
    kind = schemas.CustomFieldType
    if value is None:
        return None
    if field.type is kind.TEXT and isinstance(value, str):
        return value.strip()[:10_000] or None
    if field.type is kind.NUMBER and isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if field.type is kind.CHECKBOX and isinstance(value, bool):
        return value
    if field.type is kind.DATE and isinstance(value, str):
        if not value.strip():
            return None
        try:
            return date.fromisoformat(value.strip()).isoformat()
        except ValueError:
            pass
    if field.type is kind.DROPDOWN and isinstance(value, str):
        # A value whose option was since removed is kept until changed, but can't be chosen again.
        if not value.strip():
            return None
        if value.strip() in field.options:
            return value.strip()
    raise HTTPException(status_code=400, detail=f"Invalid value for the {field.type.value} field {field.name!r}: {value!r}")


def _custom_fields(db: Session, space_id: int | None, current: dict | None, values: dict[str, Any]) -> dict[str, Any]:
    """`current` custom field values with `values` merged in (a None value clears a field), checked against the
    space's `custom_fields_schema`."""
    space = db.get(Space, space_id or spaces.DEFAULT_SPACE_ID)
    fields = {f.id: f for f in schemas.clean_custom_fields_schema(space.custom_fields_schema if space else None)}
    merged = dict(current or {})
    for key, value in values.items():
        if key not in fields:
            raise HTTPException(status_code=400, detail=f"Unknown custom field: {key}")
        value = _custom_value(fields[key], value)
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def _check_task_update(db: Session, task: Task, changes: dict[str, Any]) -> dict[str, Any]:
    """`changes` (a `TaskUpdate` dump) checked and resolved for `task`, ready for `_apply_task_update`."""
    changes = dict(changes)
    if "project_id" in changes:
        _check_project(db, changes["project_id"])
    if "note_path" in changes:
        changes["note_path"] = _link_path(spaces.content_dir(task.space_id or spaces.DEFAULT_SPACE_ID), changes["note_path"])
    if "custom_fields" in changes:
        changes["custom_fields"] = _custom_fields(db, task.space_id, task.custom_fields, changes["custom_fields"])
    return changes


def _apply_task_update(task: Task, changes: dict[str, Any]) -> None:
    keys = (
        "assignee",
        "title",
        "description",
        "priority",
        "project_id",
        "start_date",
        "deadline",
        "tags",
        "note_path",
        "custom_fields",
        "is_gantt_task",
        "is_milestone",
    )
    for key in keys:
        if key in changes:
            setattr(task, key, changes[key])
    if "status" in changes and changes["status"] != task.status:
        task.status = changes["status"]
        task.completed_at = utcnow() if task.status == Status.DONE else None


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, request: TaskUpdate, db: Session = Depends(get_db)) -> schemas.Task:
    """Change a task: claim or unclaim it (`assignee`), move it on the board (`status`), or edit its
    title, dates, project, linked note (`note_path`; null unlinks), Gantt flags or custom fields
    (merged; a null value clears one). Unsent fields are left alone."""
    task = _get_task(db, task_id)
    changes = _check_task_update(db, task, request.model_dump(exclude_unset=True))
    set_source(db, TASK_UPDATE_SOURCE)
    _apply_task_update(task, changes)
    db.commit()
    return schemas.Task.model_validate(task, from_attributes=True)


@app.post("/api/tasks/bulk-update")
def bulk_update_tasks(request: TaskBulkUpdate, db: Session = Depends(get_db)) -> list[TaskItem]:
    """Apply the same change (a `PATCH /api/tasks/{id}` body) to several tasks, e.g. from the List view.
    Every task is checked before any is changed, so either all of them change or none does."""
    tasks = [_get_task(db, task_id) for task_id in request.task_ids]
    raw = request.updates.model_dump(exclude_unset=True)
    resolved = [(task, _check_task_update(db, task, raw)) for task in tasks]
    set_source(db, TASK_UPDATE_SOURCE)
    for task, changes in resolved:
        _apply_task_update(task, changes)
    db.commit()
    return _task_items(db, tasks)


CHECKIN_SOURCE = "evening_checkin"
# Time sheet rows logged against these (or no project at all) are overhead, not project work.
OVERHEAD_CODES = {INBOX.lower(), "overhead"}


def _timesheet_project(db: Session, code: str | None) -> Project | None:
    """The project to log hours against, created if the code has no Gantt imported yet."""
    if code is None or code.lower() in OVERHEAD_CODES:
        return None
    code = code.upper()
    # Include soft-deleted projects: their code is still taken, and past hours still count.
    project = db.scalars(
        select(Project).where(func.upper(Project.code) == code).execution_options(include_deleted=True)
    ).first()
    if project is None:
        project = Project(code=code, name=code)
        db.add(project)
        db.flush()
    return project


@app.post("/api/checkin")
def checkin(request: CheckInRequest, db: Session = Depends(get_db)) -> CheckInResponse:
    """Evening check-in: mark the day's finished tasks done and log hours, in one transaction."""
    set_source(db, CHECKIN_SOURCE)
    task_ids = list(dict.fromkeys(request.completed_task_ids))
    tasks = db.scalars(select(Task).where(Task.id.in_(task_ids))).all()
    missing = sorted(set(task_ids) - {task.id for task in tasks})
    if missing:
        raise HTTPException(status_code=404, detail=f"Unknown task ids: {missing}")

    now = utcnow()
    for task in tasks:
        if task.status != Status.DONE:  # Re-submitting keeps the original completion time.
            task.status = Status.DONE
            task.completed_at = now

    day = request.day or _today()
    logs = []
    for entry in request.time_entries:
        project = _timesheet_project(db, entry.project)
        logs.append(
            TimeLog(
                date=day,
                project_id=project.id if project else None,
                hours=entry.hours,
                notes=entry.notes.strip(),
            )
        )
    db.add_all(logs)
    db.commit()
    return CheckInResponse(
        completed_task_ids=task_ids,
        time_log_ids=[log.id for log in logs],
        total_hours=sum(log.hours for log in logs),
    )


@app.post("/api/chat")
def chat(request: ChatRequest, db: Session = Depends(get_db)) -> ChatResponse:
    """One Co-pilot turn in the active space: the agent answers the last user message, honouring `access_mode`."""
    _space_id_or_404(db, request.space_id)
    try:
        return agent.run_chat(
            request.messages,
            request.access_mode,
            space_id=request.space_id,
            note_path=request.note_path,
            model=request.model,
            reasoning_effort=request.reasoning_effort,
        )
    except agent.AgentNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


PROMPTS_SOURCE = "settings"
DEFAULT_PROMPTS = (
    schemas.SavedPromptIn(
        command="/prep",
        description="Draft a meeting prep brief",
        instruction=(
            "Prepare me for an upcoming meeting. Find the meeting note (ask me which meeting if it is not clear), "
            "read the notes from the previous meeting of the same series and list which of its action items are "
            "open or overdue."
        ),
    ),
    schemas.SavedPromptIn(
        command="/design-search",
        description="Search configured local folders for design data",
        instruction=(
            "Search the space's configured local folders using list_local_directory and read_local_file to answer "
            "the following: "
        ),
    ),
    schemas.SavedPromptIn(
        command="/rcd",
        description="Find information in RCD harmonized standards",
        instruction=(
            "Find information in the RCD regulations in "
            r"'Y:\Classification, Certification & Documentation\RCD\All harmonized standards' "
            "using list_local_directory and read_local_file to answer the following: "
        ),
    ),
)


def seed_prompts(db: Session, space_id: int) -> None:
    """Add each default slash command the space has never had (deleted ones count, so they stay deleted)."""
    had = set(
        db.scalars(
            select(SavedPrompt.command).where(SavedPrompt.space_id == space_id).execution_options(include_deleted=True)
        )
    )
    missing = [prompt for prompt in DEFAULT_PROMPTS if prompt.command not in had]
    if missing:
        set_source(db, PROMPTS_SOURCE)
        db.add_all(SavedPrompt(**{**prompt.model_dump(), "space_id": space_id}) for prompt in missing)
        db.commit()


def _get_prompt(db: Session, prompt_id: int) -> SavedPrompt:
    prompt = db.get(SavedPrompt, prompt_id)
    if prompt is None or prompt.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Unknown prompt id: {prompt_id}")
    return prompt


def _check_command_free(db: Session, space_id: int, command: str, prompt_id: int | None = None) -> None:
    clash = db.scalars(
        select(SavedPrompt).where(
            SavedPrompt.space_id == space_id, SavedPrompt.command == command, SavedPrompt.id != prompt_id
        )
    ).first()
    if clash is not None:
        raise HTTPException(status_code=409, detail=f"{command} already exists in this space")


@app.get("/api/prompts")
def list_prompts(space_id: int | None = None, db: Session = Depends(get_db)) -> list[schemas.SavedPrompt]:
    """The saved slash commands of `space_id` (of every space if not given), alphabetically."""
    query = select(SavedPrompt).order_by(SavedPrompt.command, SavedPrompt.space_id)
    if space_id is not None:
        query = query.where(SavedPrompt.space_id == space_id)
    return [schemas.SavedPrompt.model_validate(p, from_attributes=True) for p in db.scalars(query)]


@app.post("/api/prompts", status_code=201)
def create_prompt(request: schemas.SavedPromptIn, db: Session = Depends(get_db)) -> schemas.SavedPrompt:
    _space_id_or_404(db, request.space_id)
    _check_command_free(db, request.space_id, request.command)
    set_source(db, PROMPTS_SOURCE)
    prompt = SavedPrompt(**request.model_dump())
    db.add(prompt)
    db.commit()
    return schemas.SavedPrompt.model_validate(prompt, from_attributes=True)


@app.put("/api/prompts/{prompt_id}")
def update_prompt(
    prompt_id: int, request: schemas.SavedPromptIn, db: Session = Depends(get_db)
) -> schemas.SavedPrompt:
    """Edit a slash command; it stays in its space."""
    prompt = _get_prompt(db, prompt_id)
    _check_command_free(db, prompt.space_id, request.command, prompt_id)
    set_source(db, PROMPTS_SOURCE)
    for key, value in request.model_dump(exclude={"space_id"}).items():
        setattr(prompt, key, value)
    db.commit()
    return schemas.SavedPrompt.model_validate(prompt, from_attributes=True)


@app.delete("/api/prompts/{prompt_id}", status_code=204)
def delete_prompt(prompt_id: int, db: Session = Depends(get_db)) -> None:
    """Soft-delete a slash command (it stays in `history`)."""
    prompt = _get_prompt(db, prompt_id)
    set_source(db, PROMPTS_SOURCE)
    soft_delete(db, prompt)
    db.commit()


def _hidden(path: str) -> bool:
    return any(part.startswith(".") for part in path.split("/"))


@app.get("/api/notes")
def list_notes(root: Path = Depends(space_content)) -> list[NoteSummary]:
    """Every note of a space with a display title (hidden folders skipped)."""
    paths = file_layer.list_notes("**/*.md", notes_dir=root)
    return [spaces.note_summary(path, root) for path in paths if not _hidden(path)]


@app.get("/api/notes/recent")
def recent_notes(root: Path = Depends(space_content)) -> list[NoteRecent]:
    """Every note of a space with its tags, most recently modified first (for the editor's link picker)."""
    notes = []
    for path in file_layer.list_notes("**/*.md", notes_dir=root):
        if _hidden(path):
            continue
        try:
            modified = datetime.fromtimestamp((root / path).stat().st_mtime)
            tags = schemas.clean_tags(file_layer.read_note(path, notes_dir=root)["frontmatter"].get("tags"))
        except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
            continue
        notes.append(NoteRecent(**spaces.note_summary(path, root).model_dump(), tags=tags, modified=modified))
    return sorted(notes, key=lambda note: note.modified, reverse=True)


@app.get("/api/notes/file")
def get_note(
    path: str,
    space_id: int = spaces.DEFAULT_SPACE_ID,
    root: NoteRoot = NoteRoot.CONTENT,
    db: Session = Depends(get_db),
) -> NoteFile:
    """One note (or a template, with `root=templates`) with its front-matter, for the desktop note page."""
    folder = spaces.root_dir(_space_id_or_404(db, space_id), root)
    try:
        note = file_layer.read_note(path, notes_dir=folder)
    except file_layer.FileLayerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No note at {path}") from exc
    return NoteFile(path=note["path"], frontmatter=to_jsonable(note["frontmatter"]), content=note["content"])


@app.put("/api/notes/file")
def update_note(request: NoteUpdate, db: Session = Depends(get_db)) -> NoteFile:
    """Save a draft's body and/or title, set the note's tags, and/or switch it between draft and published (the
    `state` front-matter)."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    try:
        note = file_layer.read_note(request.path, notes_dir=root)
    except file_layer.FileLayerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No note at {request.path}") from exc
    if _hidden(note["path"]):
        raise HTTPException(status_code=400, detail=f"{note['path']} is in a hidden folder")
    frontmatter = dict(note["frontmatter"])
    if request.state is not None:
        frontmatter["state"] = request.state.value
    if request.title is not None:
        frontmatter["title"] = request.title
    if request.tags is not None:
        if request.tags:
            frontmatter["tags"] = request.tags
        else:
            frontmatter.pop("tags", None)
    content = note["content"] if request.content is None else request.content
    file_layer.write_note(
        note["path"], content, frontmatter, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE
    )
    return NoteFile(path=note["path"], frontmatter=to_jsonable(frontmatter), content=content)


MAX_ASSET_BYTES = 50 * 1024 * 1024
# Assets shown in the app rather than downloaded. Anything else (an HTML or SVG file, say) could run script on the
# app's origin if opened in place.
_INLINE_ASSET_SUFFIXES = {*file_layer.IMAGE_SUFFIXES.values(), ".pdf"}


# Named for images, which came first; it stores any file attached to a note, so links in saved notes keep working.
@app.post("/api/notes/image")
async def upload_image(
    file: UploadFile = File(...), space_id: int = Form(...), db: Session = Depends(get_db)
) -> ImageUpload:
    """Store an image or file pasted into the note editor under the space's `content/.assets/`."""
    root = spaces.content_dir(_space_id_or_404(db, space_id))
    data = await file.read(MAX_ASSET_BYTES + 1)
    if len(data) > MAX_ASSET_BYTES:
        raise HTTPException(status_code=413, detail=f"Files are limited to {MAX_ASSET_BYTES // (1024 * 1024)} MB")
    name = file_layer.save_asset(data, file.content_type or "", file.filename, notes_dir=root)
    return ImageUpload(url=f"/api/notes/image/{name}?space_id={space_id}")


@app.get("/api/notes/image/{name}")
def get_image(name: str, root: Path = Depends(space_content)) -> FileResponse:
    """A stored image or file; its name is random and never reused, so it can be cached for good."""
    try:
        path = file_layer.asset_path(name, notes_dir=root)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No file {name}") from exc
    headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition": "inline" if path.suffix in _INLINE_ASSET_SUFFIXES else "attachment",
        "X-Content-Type-Options": "nosniff",
    }
    return FileResponse(path, headers=headers)


@app.get("/api/notes/image/{name}/markup")
def get_image_markup(name: str, root: Path = Depends(space_content)) -> MediaMarkup:
    """The strokes and comments drawn over a stored image or PDF (none if it hasn't been marked up)."""
    try:
        markup = file_layer.read_asset_markup(name, notes_dir=root)
        return MediaMarkup() if markup is None else MediaMarkup.model_validate(markup)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No file {name}") from exc
    except ValueError:
        # A sidecar that doesn't parse or validate (edited by hand, say) reads as no markup rather than locking the file.
        return MediaMarkup()


@app.put("/api/notes/image/{name}/markup")
def put_image_markup(markup: MediaMarkup, name: str, root: Path = Depends(space_content)) -> MediaMarkup:
    """Save a stored image's or PDF's markup in its JSON sidecar, leaving the file itself as it was uploaded."""
    try:
        file_layer.write_asset_markup(name, markup.model_dump(), notes_dir=root)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No file {name}") from exc
    return markup


@app.post("/api/notes/apply-edit")
def apply_edit(request: ApplyEditRequest, db: Session = Depends(get_db)) -> ApplyEditResponse:
    """Commit an `ask_first` edit the user approved, unless the note changed since it was proposed."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    try:
        if file_layer.note_hash(request.path, notes_dir=root) != request.base_hash:
            raise HTTPException(
                status_code=409, detail=f"{request.path} changed since the edit was proposed; ask the Co-pilot again"
            )
        frontmatter = request.frontmatter
        if request.base_hash is not None:
            current = file_layer.read_note(request.path, notes_dir=root)["frontmatter"]
            # Unchanged front-matter came back through JSON (dates as strings); keep the original types.
            if to_jsonable(current) == frontmatter:
                frontmatter = current
        written = file_layer.write_note(
            request.path,
            request.content,
            frontmatter,
            AccessMode.ASK_FIRST,
            approved=True,
            notes_dir=root,
            source=agent.APPROVED_SOURCE,
        )
    except file_layer.FileLayerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = file_layer.resolve_note_path(request.path, root).relative_to(root.resolve()).as_posix()
    return ApplyEditResponse(path=path, written=written)


# --- Spaces, content tree and templates (Phase 9) -----------------------------

DESKTOP_SOURCE = "desktop"


# --- Local files -----------------------------------------------------------------
# Files and folders on this machine linked from notes (see local_files): opened here, and opened from the network share
# through a downloaded Windows shortcut by remote clients.

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _local_file_errors(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@app.post("/api/local-files/open", status_code=204)
def open_local_file(request: LocalPathRequest, http: Request) -> None:
    """Open a linked file or folder with its default program; only for a client on this machine."""
    if http.client is None or http.client.host not in _LOOPBACK:
        raise HTTPException(status_code=403, detail="Local files can only be opened on the machine running Co-Pilot")
    try:
        local_files.open_path(request.path)
    except (local_files.LocalFileError, OSError) as exc:
        raise _local_file_errors(exc) from exc


@app.get("/api/local-files/check")
def check_local_file(path: str) -> LocalFileCheck:
    """Whether a path or `file://` URL exists on this machine; never an error, so the link panel can show why not."""
    return LocalFileCheck(**local_files.check_path(path))


@app.get("/api/local-files/stat")
def stat_local_file(path: str) -> LocalFileStat:
    """A linked file or folder's name, kind and size (a folder's total), before a remote client downloads it."""
    try:
        return LocalFileStat(**local_files.stat_path(path))
    except (local_files.LocalFileError, OSError) as exc:
        raise _local_file_errors(exc) from exc


@app.get("/api/local-files/shortcut")
def get_local_file_shortcut(path: str) -> Response:
    """A Windows Internet Shortcut (`.url`) to a linked file or folder on the network share, for a remote client to open."""
    try:
        content, filename, _ = local_files.generate_shortcut_content(path)
    except (local_files.LocalFileError, OSError) as exc:
        raise _local_file_errors(exc) from exc
    ascii_name = filename.encode("ascii", "replace").decode().replace("?", "_").replace('"', "_")
    return Response(
        content=content.encode("utf-8"),
        media_type="application/x-mswinurl",
        headers={
            # Header values must be Latin-1: an ASCII fallback, and the real name for browsers that read `filename*`.
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/local-files/download")
def download_local_file(path: str) -> FileResponse:
    """A linked file, as an attachment."""
    try:
        file = local_files.file_path(path)
    except (local_files.LocalFileError, OSError) as exc:
        raise _local_file_errors(exc) from exc
    return FileResponse(file, filename=file.name, headers={"X-Content-Type-Options": "nosniff"})


@app.get("/api/local-files/download-zip")
def download_local_folder(path: str) -> FileResponse:
    """A linked folder as a ZIP, built in a temporary folder deleted once it's sent."""
    try:
        archive, name = local_files.zip_directory(path)
    except (local_files.LocalFileError, OSError) as exc:
        raise _local_file_errors(exc) from exc
    return FileResponse(
        archive, filename=name, media_type="application/zip", background=BackgroundTask(local_files.remove_temp, archive)
    )


@app.get("/api/spaces")
def list_spaces(db: Session = Depends(get_db)) -> list[schemas.Space]:
    return [schemas.Space.model_validate(s, from_attributes=True) for s in db.scalars(select(Space).order_by(Space.id))]


@app.post("/api/spaces", status_code=201)
def create_space(request: schemas.SpaceIn, db: Session = Depends(get_db)) -> schemas.Space:
    """A new space with empty content/, the starter templates, the default slash commands and task views."""
    space = spaces.create_space(db, request.name)
    seed_prompts(db, space.id)
    seed_views(db, space.id)
    return schemas.Space.model_validate(space, from_attributes=True)


@app.put("/api/spaces/{space_id}")
def update_space(space_id: int, request: schemas.SpaceUpdate, db: Session = Depends(get_db)) -> schemas.Space:
    """Rename a space and/or set its status flow, custom task fields, status colours and RAG folders; fields left out
    are kept.

    Replacing the custom fields keeps the tasks' values, except those of fields that were removed (and values
    that don't fit a field whose type changed); `renamed_options` carries renamed dropdown options over.
    """
    space = spaces.get_space(db, space_id)
    if space is None:
        raise HTTPException(status_code=404, detail=f"Unknown space id: {space_id}")
    if request.custom_fields_schema is not None:
        old_fields = schemas.clean_custom_fields_schema(space.custom_fields_schema)
        _migrate_custom_values(db, space_id, old_fields, request.custom_fields_schema, request.renamed_options)
    changes = request.model_dump(mode="json", exclude_unset=True, exclude={"renamed_options"})
    space = spaces.update_space(db, space_id, **changes)  # commits the tasks' changes too
    return schemas.Space.model_validate(space, from_attributes=True)


def _migrate_custom_values(
    db: Session,
    space_id: int,
    old_fields: list[schemas.CustomFieldDef],
    new_fields: list[schemas.CustomFieldDef],
    renamed_options: dict[str, dict[str, str]],
) -> None:
    """Bring the custom field values of a space's tasks in line with its new fields (see `update_space`)."""
    old = {f.id: f for f in old_fields}
    new = {f.id: f for f in new_fields}
    for task in db.scalars(select(Task).where(_in_space(space_id))):
        current = task.custom_fields or {}
        values = {}
        for key, value in current.items():
            field = new.get(key)
            if field is None:
                if key not in old:
                    values[key] = value  # not a field the space had; not ours to remove
                continue
            renamed = renamed_options.get(key, {}).get(value) if isinstance(value, str) else None
            if field.type is schemas.CustomFieldType.DROPDOWN and renamed in field.options:
                value = renamed
            if key in old and old[key].type is not field.type:
                try:
                    value = _custom_value(field, value)
                except HTTPException:
                    value = None
            if value is not None:
                values[key] = value
        if values != current:
            # A new dict rather than a change in place, so the JSON column is flagged dirty and versioned.
            task.custom_fields = values


@app.get("/api/tree")
def tree(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> TreeResponse:
    """A space's content/ folder tree (with Project / Reference Data flags) and its templates."""
    _space_id_or_404(db, space_id)
    return TreeResponse(
        space_id=space_id,
        content=spaces.build_tree(space_id, spaces.folder_metas(db, space_id)),
        templates=spaces.list_templates(space_id),
    )


@app.put("/api/folders/meta")
def update_folder_meta(request: FolderMetaUpdate, db: Session = Depends(get_db)) -> FolderMetaOut:
    """Mark or unmark a top-level folder as a Project (which links it to a project for tasks) or Reference Data.

    Sub-folders can only be unmarked (flags they kept from being moved under another folder).
    """
    _space_id_or_404(db, request.space_id)
    try:
        if request.is_project or request.is_reference:
            if "/" in spaces.normalize_folder(request.space_id, request.path):
                raise HTTPException(
                    status_code=400, detail="Only top-level folders can be marked as a Project or Reference Data"
                )
        meta = spaces.set_folder_meta(
            db, request.space_id, request.path, is_project=request.is_project, is_reference=request.is_reference
        )
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FolderMetaOut(
        space_id=meta.space_id,
        path=meta.path,
        is_project=meta.is_project,
        is_reference=meta.is_reference,
        project_id=meta.project_id if meta.is_project else None,
    )


@app.put("/api/folders/order")
def update_folder_order(request: FolderOrderUpdate, db: Session = Depends(get_db)) -> FolderOrderUpdate:
    """Save the custom order of a folder's notes and sub-folders (or the root's, for an empty path)."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    rel = request.path.strip().strip("/")
    if rel:
        try:
            rel = spaces.normalize_folder(request.space_id, rel)
        except file_layer.NotePathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    folder = root / rel if rel else root
    if not folder.is_dir():
        raise HTTPException(status_code=404, detail=f"No folder at {rel or 'the root'}")
    if any(not name or "/" in name or "\\" in name or name.startswith(".") for name in request.order):
        raise HTTPException(status_code=400, detail="The order lists entry names of the folder")
    spaces.write_order(folder, request.order)
    return FolderOrderUpdate(space_id=request.space_id, path=rel, order=request.order)


@app.post("/api/folders", status_code=201)
def create_folder(request: FolderCreate, db: Session = Depends(get_db)) -> schemas.FolderNode:
    """Create an empty folder under a space's content/ (parents included)."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    try:
        rel = spaces.normalize_folder(request.space_id, request.path)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    folder = root / rel
    if folder.exists():
        raise HTTPException(status_code=409, detail=f"{rel} already exists")
    folder.mkdir(parents=True)
    return schemas.FolderNode(name=folder.name, path=rel)


# `{title}`, `{date}` and `{project}` placeholders, also written `{{title}}` etc.
_PLACEHOLDER = re.compile(r"\{\{\s*(title|date|project)\s*\}\}|\{(title|date|project)\}")


def _fill_template(text: str, values: dict[str, str]) -> str:
    return _PLACEHOLDER.sub(lambda m: values[m.group(1) or m.group(2)], text)


def _fill_frontmatter(value: Any, values: dict[str, str]) -> Any:
    """Fill the placeholders of a template's front-matter value; tags left blank (no project) are dropped."""
    if isinstance(value, str):
        return _fill_template(value, values)
    if isinstance(value, list):
        filled = []
        for item in value:
            # An unquoted `- {project}` reads as the mapping `{project: null}`.
            if isinstance(item, dict) and len(item) == 1 and next(iter(item.values())) is None:
                item = f"{{{next(iter(item))}}}"
            item = _fill_frontmatter(item, values)
            if not (isinstance(item, str) and not item.strip()):
                filled.append(item)
        return filled
    if isinstance(value, dict):
        return {key: _fill_frontmatter(item, values) for key, item in value.items()}
    return value


def _folder_project_code(db: Session, space_id: int, note_path: str) -> str:
    """The project code of the note's nearest project folder, or "" outside one."""
    meta = spaces.project_folder_for(spaces.folder_metas(db, space_id), note_path)
    return meta.project.code if meta is not None and meta.project is not None else ""


# A new whiteboard page's body: an empty board (see whiteboard.ts in the desktop app).
EMPTY_WHITEBOARD = '{"grid":true,"elements":[],"markup":{"strokes":[],"comments":[]}}'


@app.post("/api/notes", status_code=201)
def create_note(request: NoteCreate, db: Session = Depends(get_db)) -> NoteFile:
    """Create a note in content/, scaffolded from a template when `template` is given.

    With `type: whiteboard` it's a whiteboard page, an empty board, instead. Templates may use `{title}`, `{date}` and
    `{project}` placeholders (or `{{title}}` etc.) in their body and
    front-matter values; `{project}` is the code of the note's project folder, e.g. `tags: ["{project}"]`.
    """
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    path = request.path.strip().strip("/")
    if not path.lower().endswith(file_layer.NOTE_SUFFIX):
        path += file_layer.NOTE_SUFFIX
    try:
        resolved = file_layer.resolve_note_path(path, root)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    rel = resolved.relative_to(root.resolve()).as_posix()
    if _hidden(rel):
        raise HTTPException(status_code=400, detail=f"{rel} is in a hidden folder")
    if resolved.exists():
        raise HTTPException(status_code=409, detail=f"{rel} already exists")

    today = _today()
    title = (request.title or "").strip() or resolved.stem
    frontmatter: dict[str, Any] = {}
    content = ""
    project = _folder_project_code(db, request.space_id, rel)
    
    if request.type == "whiteboard":
        frontmatter["type"] = "whiteboard"
        content = EMPTY_WHITEBOARD
    elif request.template:
        try:
            template = file_layer.read_note(request.template, notes_dir=spaces.templates_dir(request.space_id))
        except file_layer.FileLayerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"No template at {request.template}") from exc
        values = {
            "title": title,
            "date": today.isoformat(),
            "project": project,
        }
        frontmatter = {key: _fill_frontmatter(value, values) for key, value in template["frontmatter"].items()}
        content = _fill_template(template["content"], values)
        
    if project:
        tags = frontmatter.get("tags", [])
        if isinstance(tags, list) and project not in tags:
            frontmatter["tags"] = tags + [project]

    frontmatter.setdefault("created", today.isoformat())
    frontmatter.setdefault("state", NoteState.DRAFT.value)
    file_layer.write_note(rel, content, frontmatter, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)
    return NoteFile(path=rel, frontmatter=to_jsonable(frontmatter), content=content)


# --- Organizing content/: move, rename, duplicate, delete (Phase 9.2) ---------


def _content_entry(root: Path, path: str) -> ContentEntry:
    """An existing note or folder of content/ (400 for a path outside it or hidden, 404 if missing)."""
    try:
        resolved = file_layer.resolve_folder_path(path.strip().strip("/"), root)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    rel = resolved.relative_to(root.resolve()).as_posix()
    if _hidden(rel):
        raise HTTPException(status_code=400, detail=f"{rel} is hidden")
    if resolved.is_dir():
        return ContentEntry(kind=ContentKind.FOLDER, path=rel)
    if resolved.is_file() and resolved.suffix.lower() == file_layer.NOTE_SUFFIX:
        return ContentEntry(kind=ContentKind.NOTE, path=rel)
    raise HTTPException(status_code=404, detail=f"No note or folder at {path}")


def _sibling(path: str, name: str) -> str:
    parent = path.rpartition("/")[0]
    return f"{parent}/{name}" if parent else name


def _retitle(root: Path, path: str, old_title: str, new_title: str) -> None:
    """Keep a note's displayed title in step with its new name: its front-matter `title`, or a
    first-line heading that shows `old_title`. Other notes are titled by their file name already."""
    try:
        note = file_layer.read_note(path, notes_dir=root)
    except (file_layer.FileLayerError, UnicodeDecodeError):
        return
    frontmatter, content = note["frontmatter"], note["content"]
    if str(frontmatter.get("title") or "").strip():
        frontmatter = {**frontmatter, "title": new_title}
    else:
        heading = re.match(r"(\s*#+[ \t]*)([^\r\n]*)", content)
        if heading is None or heading.group(2).strip() != old_title:
            return
        content = heading.group(1) + new_title + content[heading.end():]
    file_layer.write_note(path, content, frontmatter, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)


def _move_entry(db: Session, space_id: int, root: Path, entry: ContentEntry, new_path: str) -> ContentEntry:
    """Move or rename a note or folder, taking its folder flags and task links along."""
    if new_path == entry.path:
        return entry
    move = file_layer.rename_note if entry.kind is ContentKind.NOTE else file_layer.move_folder
    try:
        move(entry.path, new_path, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"{new_path} already exists") from exc
    spaces.relocate(db, space_id, entry.path, new_path)
    return ContentEntry(kind=entry.kind, path=new_path)


@app.post("/api/content/move")
def move_content(request: ContentMove, db: Session = Depends(get_db)) -> ContentEntry:
    """Move a note or folder into another folder of content/ (drag and drop in the tree)."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    entry = _content_entry(root, request.path)
    destination = request.destination.strip().strip("/")
    if destination:
        try:
            destination = spaces.normalize_folder(request.space_id, destination)
        except file_layer.NotePathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not (root / destination).is_dir():
            raise HTTPException(status_code=404, detail=f"No folder at {destination}")
    name = entry.path.rpartition("/")[2]
    return _move_entry(db, request.space_id, root, entry, f"{destination}/{name}" if destination else name)


@app.post("/api/content/rename")
def rename_content(request: ContentRename, db: Session = Depends(get_db)) -> ContentEntry:
    """Rename a note (keeping `.md`, and retitling it) or a folder in place."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    entry = _content_entry(root, request.path)
    name = request.name
    if entry.kind is ContentKind.NOTE:
        old_title = spaces.note_summary(entry.path, root).title
        name = name if name.lower().endswith(file_layer.NOTE_SUFFIX) else name + file_layer.NOTE_SUFFIX
    moved = _move_entry(db, request.space_id, root, entry, _sibling(entry.path, name))
    if entry.kind is ContentKind.NOTE:
        _retitle(root, moved.path, old_title, request.name.removesuffix(file_layer.NOTE_SUFFIX))
    return moved


@app.post("/api/content/duplicate", status_code=201)
def duplicate_content(request: ContentRef, db: Session = Depends(get_db)) -> ContentEntry:
    """Copy a note or folder next to itself as `<name> (copy)`, `<name> (copy 2)`, …

    Folder flags are not copied: a copied project folder is not the same project.
    """
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    entry = _content_entry(root, request.path)
    name = entry.path.rpartition("/")[2]
    suffix = file_layer.NOTE_SUFFIX if entry.kind is ContentKind.NOTE else ""
    stem = name[: len(name) - len(suffix)]
    label, n = "copy", 1
    while (root / _sibling(entry.path, f"{stem} ({label}){suffix}")).exists():
        n += 1
        label = f"copy {n}"
    path = _sibling(entry.path, f"{stem} ({label}){suffix}")
    if entry.kind is ContentKind.NOTE:
        title = spaces.note_summary(entry.path, root).title
        file_layer.copy_note(entry.path, path, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)
        _retitle(root, path, title, f"{title} ({label})")
    else:
        file_layer.copy_folder(entry.path, path, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)
    return ContentEntry(kind=entry.kind, path=path)


@app.delete("/api/content", status_code=204)
def delete_content(path: str, space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> None:
    """Delete a note, or a folder with everything in it. Deleted notes stay in `history`."""
    root = spaces.content_dir(_space_id_or_404(db, space_id))
    entry = _content_entry(root, path)
    if entry.kind is ContentKind.NOTE:
        file_layer.delete_note(entry.path, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)
    else:
        file_layer.delete_folder(entry.path, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE)
    spaces.forget(db, space_id, entry.path)


# --- Task engine (Phase 9) ----------------------------------------------------


@app.get("/api/projects")
def list_projects(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> list[ProjectOption]:
    """The projects of a space, for task filters and pickers, with their project folder if any."""
    projects = _space_projects(db, _space_id_or_404(db, space_id))
    folders = {
        meta.project_id: meta.path
        for meta in spaces.folder_metas(db, space_id).values()
        if meta.is_project and meta.project_id is not None
    }
    return [
        ProjectOption(id=p.id, code=p.code, name=p.name, color=p.color, folder_path=folders.get(p.id)) for p in projects
    ]


@app.put("/api/projects/{project_id}")
def update_project(project_id: int, request: schemas.ProjectUpdate, db: Session = Depends(get_db)) -> schemas.Project:
    """Rename a project or change its description or colour (`color: null` goes back to the default); unsent
    fields are kept. Renaming also changes its code (its tag) to the new name, renaming that tag on every task
    and note."""
    project = db.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Unknown project id: {project_id}")
    set_source(db, DESKTOP_SOURCE)
    old_code = project.code
    new_code = old_code
    if request.name is not None and request.name != project.name:
        new_code = request.name[: spaces._CODE_MAX]
        if new_code != old_code:
            taken = db.scalars(
                select(Project.id)
                .where(func.upper(Project.code) == new_code.upper(), Project.id != project.id)
                .execution_options(include_deleted=True)
            ).first()
            if taken is not None:
                raise HTTPException(status_code=400, detail="Project code already in use")
            project.code = new_code
            for task in db.scalars(select(Task).where(Task.tags.is_not(None))):
                tags = _renamed_tags(task.tags, old_code, new_code)
                if tags is not None:
                    task.tags = tags
    for key, value in request.model_dump(exclude_unset=True).items():
        setattr(project, key, value)
    db.commit()
    if new_code != old_code:
        _rename_note_tags(db, old_code, new_code)
    return schemas.Project.model_validate(project, from_attributes=True)


def _renamed_tags(value: Any, old: str, new: str) -> list[str] | None:
    """Tags with `old` (any case) replaced by `new`, or None if `old` is not among them."""
    tags = schemas.clean_tags(value)
    if not any(tag.lower() == old.lower() for tag in tags):
        return None
    return list(dict.fromkeys(new if tag.lower() == old.lower() else tag for tag in tags))


def _rename_note_tags(db: Session, old: str, new: str) -> None:
    """Rename a tag in the front-matter of every note of every space."""
    for space in db.scalars(select(Space)).all():
        root = spaces.content_dir(space.id)
        if not root.is_dir():
            continue
        for path in file_layer.list_notes("**/*.md", notes_dir=root):
            if _hidden(path):
                continue
            try:
                note = file_layer.read_note(path, notes_dir=root)
                frontmatter = note["frontmatter"]
                tags = _renamed_tags(frontmatter.get("tags"), old, new)
                if tags is None:
                    continue
                frontmatter["tags"] = tags
                file_layer.write_note(
                    path, note["content"], frontmatter, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE
                )
            except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
                continue  # A hand-edited note with broken front-matter must not stop the rename.


def _task_items(db: Session, tasks: list[Task]) -> list[TaskItem]:
    project_ids = {t.project_id for t in tasks if t.project_id is not None}
    projects = {
        project_id: (code, color)
        for project_id, code, color in db.execute(
            select(Project.id, Project.code, Project.color)
            .where(Project.id.in_(project_ids))
            .execution_options(include_deleted=True)
        )
    }
    return [
        TaskItem(
            id=t.id,
            space_id=t.space_id or spaces.DEFAULT_SPACE_ID,
            project_id=t.project_id,
            project_code=projects.get(t.project_id, (None, None))[0],
            project_color=projects.get(t.project_id, (None, None))[1],
            title=t.title,
            description=t.description,
            status=t.status,
            priority=t.priority,
            assignee=t.assignee,
            start_date=t.start_date,
            deadline=t.deadline,
            completion_percent=t.completion_percent,
            is_gantt_task=t.is_gantt_task,
            is_milestone=t.is_milestone,
            tags=schemas.clean_tags(t.tags),
            note_path=t.note_path,
            comments=schemas.clean_comments(t.comments),
            custom_fields=t.custom_fields or {},
        )
        for t in tasks
    ]


def _link_path(root: Path, note_path: str | None) -> str | None:
    """A linkable note: an existing note in the space's content/, as a path relative to it.
    None (or blank) means no note."""
    if note_path is None or not note_path.strip():
        return None
    try:
        path = file_layer.resolve_note_path(note_path, root)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"No note at {note_path}")
    return path.relative_to(root.resolve()).as_posix()


# `cf=<field id>:*` matches tasks with any value in that field.
ANY_VALUE = "*"


def _custom_field_matches(field: schemas.CustomFieldDef, value: Any, wanted: str) -> bool:
    """Whether a task's stored `value` (None if unset) of a custom field matches the filter text `wanted`.

    "" matches tasks without a value and "*" those with one. Otherwise text fields match case-insensitively
    anywhere in the value, numbers by value, checkboxes by "true"/"false" (unset counts as false), and dates and
    dropdowns exactly.
    """
    kind = schemas.CustomFieldType
    unset = value is None or (field.type is kind.CHECKBOX and value is False)
    if wanted == "":
        return unset
    if wanted == ANY_VALUE:
        return not unset
    if field.type is kind.CHECKBOX:
        return wanted.lower() == ("false" if unset else "true")
    if value is None:
        return False
    if field.type is kind.TEXT:
        return wanted.lower() in str(value).lower()
    if field.type is kind.NUMBER:
        try:
            return float(wanted) == float(value)
        except (TypeError, ValueError):
            return False
    return str(value) == wanted


def _parse_cf(params: list[str]) -> dict[str, str]:
    """`cf=<field id>:<value>` query parameters as field id -> value (the value may contain colons)."""
    filters = {}
    for param in params:
        field_id, sep, wanted = param.partition(":")
        if not sep or not field_id.strip():
            raise HTTPException(status_code=400, detail=f"cf must look like <field id>:<value>, not {param!r}")
        filters[field_id.strip()] = wanted.strip()
    return filters


@app.get("/api/tasks")
def list_tasks(
    space_id: int = spaces.DEFAULT_SPACE_ID,
    project_id: list[int] | None = Query(default=None),
    assignee: list[str] | None = Query(default=None),
    status: list[Status] | None = Query(default=None),
    note_path: str | None = None,
    tag: str | None = None,
    include_archived: bool = False,
    cf: list[str] = Query(default=[]),
    has_deadline: bool | None = None,
    has_start_date: bool | None = None,
    due_after: date | None = None,
    due_before: date | None = None,
    priority: list[Priority] | None = Query(default=None),
    is_gantt_task: bool | None = None,
    is_milestone: bool | None = None,
    has_note: bool | None = None,
    start_after: date | None = None,
    start_before: date | None = None,
    db: Session = Depends(get_db),
) -> list[TaskItem]:
    """The tasks of a space for the Kanban, Backlog, Gantt and List views, earliest due date first.

    Filters: `project_id`, `status`, `note_path` (tasks linked to that note), `tag` (tasks with
    that tag), and `assignee` (an empty `assignee=` means unassigned). `project_id`, `assignee`, `status`
    and `priority` are repeatable and match any of the values given. Archived tasks are left out
    unless `include_archived` is set or `status=archived` asks for them.

    Advanced filters: `cf=<field id>:<value>` (repeatable; see `_custom_field_matches`; fields the space
    no longer has are ignored), `has_deadline` / `has_start_date` (true: set, false: not set), and
    `due_after` / `due_before` (due on or after / on or before that day; tasks without a due date are left out),
    `start_after` / `start_before` (likewise for the start date), `priority`, `is_gantt_task`, `is_milestone`, and
    `has_note` (true: linked to a note, false: not linked).
    """
    custom_filters = _parse_cf(cf)
    query = select(Task).where(_in_space(_space_id_or_404(db, space_id)))
    if project_id:
        query = query.where(Task.project_id.in_(project_id))
    if assignee:
        names = {name.strip() for name in assignee}
        matches = [Task.assignee.in_(names - {""})]
        if "" in names:
            matches.append(Task.assignee.is_(None))
        query = query.where(or_(*matches))
    if status:
        query = query.where(Task.status.in_(status))
    elif not include_archived:
        query = query.where(Task.status != Status.ARCHIVED)
    if note_path is not None:
        query = query.where(Task.note_path == note_path)
    if has_deadline is not None:
        query = query.where(Task.deadline.is_not(None) if has_deadline else Task.deadline.is_(None))
    if has_start_date is not None:
        query = query.where(Task.start_date.is_not(None) if has_start_date else Task.start_date.is_(None))
    if due_after is not None:
        query = query.where(Task.deadline >= due_after)
    if due_before is not None:
        query = query.where(Task.deadline <= due_before)
    if start_after is not None:
        query = query.where(Task.start_date >= start_after)
    if start_before is not None:
        query = query.where(Task.start_date <= start_before)
    if priority:
        query = query.where(Task.priority.in_(priority))
    if is_gantt_task is not None:
        query = query.where(Task.is_gantt_task.is_(is_gantt_task))
    if is_milestone is not None:
        query = query.where(Task.is_milestone.is_(is_milestone))
    if has_note is not None:
        query = query.where(Task.note_path.is_not(None) if has_note else Task.note_path.is_(None))
    query = query.order_by(Task.deadline.is_(None), Task.deadline, Task.start_date.is_(None), Task.start_date, Task.id)
    tasks = list(db.scalars(query))
    if tag is not None and tag.strip():
        # Tags are a JSON list, so match them here rather than in SQL.
        tasks = [t for t in tasks if tag.strip() in schemas.clean_tags(t.tags)]
    if custom_filters:
        # Custom field values are JSON as well.
        space = db.get(Space, space_id)
        fields = {f.id: f for f in schemas.clean_custom_fields_schema(space.custom_fields_schema)}
        checks = [(fields[key], wanted) for key, wanted in custom_filters.items() if key in fields]
        tasks = [
            t
            for t in tasks
            if all(_custom_field_matches(field, (t.custom_fields or {}).get(field.id), wanted) for field, wanted in checks)
        ]
    return _task_items(db, tasks)


@app.get("/api/spaces/{space_id}/tags")
def list_tags(space_id: int, db: Session = Depends(get_db)) -> list[str]:
    """Every tag used on the tasks and notes of a space, sorted case-insensitively (tag filter, tag autocomplete)."""
    space_id = _space_id_or_404(db, space_id)
    query = select(Task.tags).where(_in_space(space_id))
    tags = {tag for task_tags in db.scalars(query) for tag in schemas.clean_tags(task_tags)}
    root = spaces.content_dir(space_id)
    for path in file_layer.list_notes("**/*.md", notes_dir=root):
        if _hidden(path):
            continue
        try:
            tags.update(schemas.clean_tags(file_layer.read_note(path, notes_dir=root)["frontmatter"].get("tags")))
        except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
            continue  # A hand-edited note with broken front-matter must not break the whole list.
    return sorted(tags, key=lambda tag: (tag.lower(), tag))


@app.post("/api/tasks", status_code=201)
def create_task(request: TaskCreate, db: Session = Depends(get_db)) -> TaskItem:
    """Create a task in a space, optionally in a project and linked to a note (`note_path`)."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    _check_project(db, request.project_id)
    note_path = _link_path(root, request.note_path)
    custom_fields = _custom_fields(db, request.space_id, {}, request.custom_fields)
    set_source(db, DESKTOP_SOURCE)
    task = Task(
        **request.model_dump(exclude={"note_path", "custom_fields"}),
        note_path=note_path,
        custom_fields=custom_fields,
        is_gantt_task=False,
    )
    if task.status == Status.DONE:
        task.completed_at = utcnow()
    db.add(task)
    db.commit()
    return _task_items(db, [task])[0]


@app.get("/api/tasks/{task_id}")
def get_task(task_id: int, db: Session = Depends(get_db)) -> TaskItem:
    return _task_items(db, [_get_task(db, task_id)])[0]


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, db: Session = Depends(get_db)) -> None:
    """Soft-delete a task (it stays in `history`)."""
    task = _get_task(db, task_id)
    set_source(db, DESKTOP_SOURCE)
    soft_delete(db, task)
    db.commit()


def _save_comments(db: Session, task: Task, comments: list[schemas.TaskComment]) -> TaskItem:
    # Assign a new list (not an in-place change) so the JSON column is flagged dirty and versioned.
    set_source(db, DESKTOP_SOURCE)
    task.comments = [comment.model_dump(mode="json") for comment in comments]
    db.commit()
    return _task_items(db, [task])[0]


def _comment_index(comments: list[schemas.TaskComment], comment_id: str) -> int:
    for index, comment in enumerate(comments):
        if comment.id == comment_id:
            return index
    raise HTTPException(status_code=404, detail=f"Unknown comment id: {comment_id}")


@app.post("/api/tasks/{task_id}/comments", status_code=201)
def add_task_comment(task_id: int, request: TaskCommentIn, db: Session = Depends(get_db)) -> TaskItem:
    """Add a comment to the end of a task's discussion."""
    task = _get_task(db, task_id)
    comments = schemas.clean_comments(task.comments)
    comments.append(
        schemas.TaskComment(id=secrets.token_hex(6), author=request.author, text=request.text, created_at=utcnow())
    )
    return _save_comments(db, task, comments)


@app.patch("/api/tasks/{task_id}/comments/{comment_id}")
def edit_task_comment(task_id: int, comment_id: str, request: TaskCommentIn, db: Session = Depends(get_db)) -> TaskItem:
    """Change a comment's text; its author and creation time are kept."""
    task = _get_task(db, task_id)
    comments = schemas.clean_comments(task.comments)
    index = _comment_index(comments, comment_id)
    comments[index] = comments[index].model_copy(update={"text": request.text, "updated_at": utcnow()})
    return _save_comments(db, task, comments)


@app.delete("/api/tasks/{task_id}/comments/{comment_id}")
def delete_task_comment(task_id: int, comment_id: str, db: Session = Depends(get_db)) -> TaskItem:
    """Remove a comment (the previous state stays in `history`)."""
    task = _get_task(db, task_id)
    comments = schemas.clean_comments(task.comments)
    del comments[_comment_index(comments, comment_id)]
    return _save_comments(db, task, comments)


# --- Saved task views (Phase 9.1) -------------------------------------------------

VIEWS_SOURCE = "desktop"
DEFAULT_VIEWS = (
    ("Kanban", schemas.ViewType.KANBAN),
    ("Backlog", schemas.ViewType.BACKLOG),
    ("Gantt", schemas.ViewType.GANTT),
)


def seed_views(db: Session, space_id: int) -> None:
    """Give a space that has never had any task views (deleted ones count) one of each type."""
    seen = select(TaskView).where(TaskView.space_id == space_id).execution_options(include_deleted=True)
    if db.scalars(seen.limit(1)).first() is None:
        set_source(db, VIEWS_SOURCE)
        db.add_all(TaskView(space_id=space_id, name=name, view_type=kind, filters={}) for name, kind in DEFAULT_VIEWS)
        db.commit()


def _view_out(view: TaskView) -> schemas.TaskView:
    return schemas.TaskView(
        id=view.id,
        space_id=view.space_id,
        name=view.name,
        view_type=view.view_type,
        # Filters saved by an older version may lack keys or carry stale ones.
        filters=schemas.TaskViewFilters.model_validate(view.filters or {}),
        created_at=view.created_at,
    )


def _get_view(db: Session, view_id: int) -> TaskView:
    view = db.get(TaskView, view_id)
    if view is None or view.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Unknown view id: {view_id}")
    return view


@app.get("/api/views")
def list_views(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> list[schemas.TaskView]:
    """The saved task views of a space, in the order they were created."""
    query = select(TaskView).where(TaskView.space_id == _space_id_or_404(db, space_id)).order_by(TaskView.id)
    return [_view_out(v) for v in db.scalars(query)]


@app.get("/api/views/{view_id}")
def get_view(view_id: int, db: Session = Depends(get_db)) -> schemas.TaskView:
    return _view_out(_get_view(db, view_id))


@app.post("/api/views", status_code=201)
def create_view(request: schemas.TaskViewIn, db: Session = Depends(get_db)) -> schemas.TaskView:
    _space_id_or_404(db, request.space_id)
    for project_id in request.filters.project_id or []:
        _check_project(db, project_id)
    set_source(db, VIEWS_SOURCE)
    view = TaskView(
        space_id=request.space_id,
        name=request.name,
        view_type=request.view_type,
        filters=request.filters.model_dump(mode="json"),
    )
    db.add(view)
    db.commit()
    return _view_out(view)


@app.put("/api/views/{view_id}")
def update_view(view_id: int, request: schemas.TaskViewUpdate, db: Session = Depends(get_db)) -> schemas.TaskView:
    """Rename a view and/or replace its filters; fields left out are kept."""
    view = _get_view(db, view_id)
    if request.filters is not None:
        for project_id in request.filters.project_id or []:
            _check_project(db, project_id)
    set_source(db, VIEWS_SOURCE)
    if request.name is not None:
        view.name = request.name
    if request.filters is not None:
        view.filters = request.filters.model_dump(mode="json")
    db.commit()
    return _view_out(view)


@app.delete("/api/views/{view_id}", status_code=204)
def delete_view(view_id: int, db: Session = Depends(get_db)) -> None:
    """Soft-delete a view (it stays in `history`); its tasks are untouched."""
    view = _get_view(db, view_id)
    set_source(db, VIEWS_SOURCE)
    soft_delete(db, view)
    db.commit()


# --- People -----------------------------------------------------------------------

PEOPLE_SOURCE = "desktop"


def _get_person(db: Session, person_id: int) -> Person:
    person = db.get(Person, person_id)
    if person is None or person.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Unknown person id: {person_id}")
    return person


def _only_me(db: Session, person: Person) -> None:
    """If `person` is "me", nobody else in their space is any more."""
    if not person.is_me:
        return
    others = select(Person).where(Person.space_id == person.space_id, Person.is_me.is_(True), Person.id != person.id)
    for other in db.scalars(others):
        other.is_me = False


@app.get("/api/people")
def list_people(space_id: int = spaces.DEFAULT_SPACE_ID, db: Session = Depends(get_db)) -> list[schemas.Person]:
    """The People directory of a space, by name."""
    query = select(Person).where(Person.space_id == _space_id_or_404(db, space_id))
    people = sorted(db.scalars(query), key=lambda p: (p.name.lower(), p.id))
    return [schemas.Person.model_validate(p, from_attributes=True) for p in people]


@app.post("/api/people", status_code=201)
def create_person(request: schemas.PersonIn, db: Session = Depends(get_db)) -> schemas.Person:
    _space_id_or_404(db, request.space_id)
    set_source(db, PEOPLE_SOURCE)
    person = Person(**request.model_dump())
    db.add(person)
    db.flush()
    _only_me(db, person)
    db.commit()
    return schemas.Person.model_validate(person, from_attributes=True)


@app.get("/api/people/{person_id}")
def get_person(person_id: int, db: Session = Depends(get_db)) -> schemas.Person:
    return schemas.Person.model_validate(_get_person(db, person_id), from_attributes=True)


@app.put("/api/people/{person_id}")
def update_person(person_id: int, request: schemas.PersonIn, db: Session = Depends(get_db)) -> schemas.Person:
    """Replace a person's details (`is_me` too: marking someone unmarks the rest of the space). A person
    can't move to another space."""
    person = _get_person(db, person_id)
    if request.space_id != person.space_id:
        raise HTTPException(status_code=400, detail="A person can't move to another space")
    set_source(db, PEOPLE_SOURCE)
    for key, value in request.model_dump(exclude={"space_id"}).items():
        setattr(person, key, value)
    _only_me(db, person)
    db.commit()
    return schemas.Person.model_validate(person, from_attributes=True)


@app.delete("/api/people/{person_id}", status_code=204)
def delete_person(person_id: int, db: Session = Depends(get_db)) -> None:
    """Soft-delete a person (they stay in `history`)."""
    person = _get_person(db, person_id)
    set_source(db, PEOPLE_SOURCE)
    soft_delete(db, person)
    db.commit()


if __name__ == "__main__":
    import uvicorn

    from config import get_settings

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
