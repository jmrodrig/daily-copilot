"""FastAPI entry point. Run with `uvicorn main:app --reload` from backend/."""

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Any

from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

import agent
import file_layer
import database
import spaces
from database import get_db, init_db
from history import set_source, soft_delete, to_jsonable, utcnow
from models import FolderMeta, Project, SavedPrompt, Space, Task, TaskNoteLink, TaskView, TimeLog
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
    FolderMetaOut,
    FolderMetaUpdate,
    NoteCreate,
    NoteFile,
    NoteRoot,
    NoteState,
    NoteSummary,
    NoteUpdate,
    Priority,
    ProjectOption,
    Status,
    TaskCreate,
    TaskItem,
    TaskNoteLinkIn,
    TaskUpdate,
    TreeResponse,
    TriageItem,
    TriageKind,
    TriageRank,
)

INBOX = "Inbox"
CAPTURE_SOURCE = "android_app"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    with database.SessionLocal() as db:
        spaces.migrate(db)
        seed_prompts(db)
        for space in db.scalars(select(Space)).all():
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
            Task.is_gantt_task.is_(True), Task.project_id.in_([p.id for p in projects]), _in_space(space_id)
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
                tasks=[
                    GanttTask(
                        id=task.id,
                        name=task.title,
                        start_date=task.start_date,
                        end_date=task.deadline,
                        completion_percent=task.completion_percent,
                        status=task.status,
                        is_milestone=task.is_milestone,
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
            Task.status != Status.DONE,
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


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, request: TaskUpdate, db: Session = Depends(get_db)) -> schemas.Task:
    """Change a task: claim or unclaim it (`assignee`), move it on the board (`status`), or edit its
    title, dates or project. Unsent fields are left alone."""
    task = _get_task(db, task_id)
    set_source(db, TASK_UPDATE_SOURCE)
    changes = request.model_dump(exclude_unset=True)
    if "project_id" in changes:
        _check_project(db, changes["project_id"])
    for key in ("assignee", "title", "description", "priority", "project_id", "start_date", "deadline"):
        if key in changes:
            setattr(task, key, changes[key])
    if "status" in changes and changes["status"] != task.status:
        task.status = changes["status"]
        task.completed_at = utcnow() if task.status == Status.DONE else None
    db.commit()
    return schemas.Task.model_validate(task, from_attributes=True)


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
            request.messages, request.access_mode, space_id=request.space_id, note_path=request.note_path
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
            "still open. Check the project's open and overdue tasks. Then draft a prep brief "
            "in the meeting note: open items carried over, schedule risks, and questions to raise."
        ),
    ),
)


def seed_prompts(db: Session) -> None:
    """Add the default slash commands to a database that has never had any (deleted ones count)."""
    if db.scalars(select(SavedPrompt).execution_options(include_deleted=True).limit(1)).first() is None:
        set_source(db, PROMPTS_SOURCE)
        db.add_all(SavedPrompt(**prompt.model_dump()) for prompt in DEFAULT_PROMPTS)
        db.commit()


def _get_prompt(db: Session, prompt_id: int) -> SavedPrompt:
    prompt = db.get(SavedPrompt, prompt_id)
    if prompt is None or prompt.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Unknown prompt id: {prompt_id}")
    return prompt


def _check_command_free(db: Session, command: str, prompt_id: int | None = None) -> None:
    clash = db.scalars(select(SavedPrompt).where(SavedPrompt.command == command, SavedPrompt.id != prompt_id)).first()
    if clash is not None:
        raise HTTPException(status_code=409, detail=f"{command} already exists")


@app.get("/api/prompts")
def list_prompts(db: Session = Depends(get_db)) -> list[schemas.SavedPrompt]:
    """The saved slash commands, alphabetically."""
    prompts = db.scalars(select(SavedPrompt).order_by(SavedPrompt.command)).all()
    return [schemas.SavedPrompt.model_validate(p, from_attributes=True) for p in prompts]


@app.post("/api/prompts", status_code=201)
def create_prompt(request: schemas.SavedPromptIn, db: Session = Depends(get_db)) -> schemas.SavedPrompt:
    _check_command_free(db, request.command)
    set_source(db, PROMPTS_SOURCE)
    prompt = SavedPrompt(**request.model_dump())
    db.add(prompt)
    db.commit()
    return schemas.SavedPrompt.model_validate(prompt, from_attributes=True)


@app.put("/api/prompts/{prompt_id}")
def update_prompt(
    prompt_id: int, request: schemas.SavedPromptIn, db: Session = Depends(get_db)
) -> schemas.SavedPrompt:
    prompt = _get_prompt(db, prompt_id)
    _check_command_free(db, request.command, prompt_id)
    set_source(db, PROMPTS_SOURCE)
    for key, value in request.model_dump().items():
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
    """Save a draft's body and/or switch it between draft and published (the `state` front-matter)."""
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
    content = note["content"] if request.content is None else request.content
    file_layer.write_note(
        note["path"], content, frontmatter, AccessMode.WRITE_DIRECTLY, notes_dir=root, source=DESKTOP_SOURCE
    )
    return NoteFile(path=note["path"], frontmatter=to_jsonable(frontmatter), content=content)


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


@app.get("/api/spaces")
def list_spaces(db: Session = Depends(get_db)) -> list[schemas.Space]:
    return [schemas.Space.model_validate(s, from_attributes=True) for s in db.scalars(select(Space).order_by(Space.id))]


@app.post("/api/spaces", status_code=201)
def create_space(request: schemas.SpaceIn, db: Session = Depends(get_db)) -> schemas.Space:
    """A new space with empty content/, the starter templates and the default task views."""
    space = spaces.create_space(db, request.name)
    seed_views(db, space.id)
    return schemas.Space.model_validate(space, from_attributes=True)


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


def _fill_template(text: str, title: str, today: date) -> str:
    return text.replace("{title}", title).replace("{date}", today.isoformat())


@app.post("/api/notes", status_code=201)
def create_note(request: NoteCreate, db: Session = Depends(get_db)) -> NoteFile:
    """Create a note in content/, scaffolded from a template when `template` is given.

    Templates may use `{title}` and `{date}` placeholders in their body and front-matter values.
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
    content = f"# {title}\n"
    if request.template:
        try:
            template = file_layer.read_note(request.template, notes_dir=spaces.templates_dir(request.space_id))
        except file_layer.FileLayerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"No template at {request.template}") from exc
        frontmatter = {
            key: _fill_template(value, title, today) if isinstance(value, str) else value
            for key, value in template["frontmatter"].items()
        }
        content = _fill_template(template["content"], title, today)
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
    return [ProjectOption(id=p.id, code=p.code, name=p.name, folder_path=folders.get(p.id)) for p in projects]


def _task_items(db: Session, tasks: list[Task]) -> list[TaskItem]:
    ids = [t.id for t in tasks]
    links: dict[int, list[str]] = {}
    for link in db.scalars(select(TaskNoteLink).where(TaskNoteLink.task_id.in_(ids)).order_by(TaskNoteLink.note_path)):
        links.setdefault(link.task_id, []).append(link.note_path)
    project_ids = {t.project_id for t in tasks if t.project_id is not None}
    codes = dict(
        db.execute(
            select(Project.id, Project.code).where(Project.id.in_(project_ids)).execution_options(include_deleted=True)
        ).all()
    )
    return [
        TaskItem(
            id=t.id,
            space_id=t.space_id or spaces.DEFAULT_SPACE_ID,
            project_id=t.project_id,
            project_code=codes.get(t.project_id),
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
            note_paths=links.get(t.id, []),
        )
        for t in tasks
    ]


def _link_path(root: Path, note_path: str) -> str:
    """A linkable note: an existing note in the space's content/, as a path relative to it."""
    try:
        path = file_layer.resolve_note_path(note_path, root)
    except file_layer.NotePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"No note at {note_path}")
    return path.relative_to(root.resolve()).as_posix()


@app.get("/api/tasks")
def list_tasks(
    space_id: int = spaces.DEFAULT_SPACE_ID,
    project_id: int | None = None,
    assignee: str | None = None,
    status: Status | None = None,
    note_path: str | None = None,
    db: Session = Depends(get_db),
) -> list[TaskItem]:
    """The tasks of a space for the Kanban, Backlog and Gantt views, earliest due date first.

    Filters: `project_id`, `status`, `note_path` (tasks linked to that note), and `assignee`
    (an empty `assignee=` means unassigned).
    """
    query = select(Task).where(_in_space(_space_id_or_404(db, space_id)))
    if project_id is not None:
        query = query.where(Task.project_id == project_id)
    if assignee is not None:
        query = query.where(Task.assignee.is_(None) if not assignee.strip() else Task.assignee == assignee.strip())
    if status is not None:
        query = query.where(Task.status == status)
    if note_path is not None:
        query = query.where(Task.id.in_(select(TaskNoteLink.task_id).where(TaskNoteLink.note_path == note_path)))
    query = query.order_by(Task.deadline.is_(None), Task.deadline, Task.start_date.is_(None), Task.start_date, Task.id)
    return _task_items(db, list(db.scalars(query)))


@app.post("/api/tasks", status_code=201)
def create_task(request: TaskCreate, db: Session = Depends(get_db)) -> TaskItem:
    """Create a task in a space, optionally in a project and linked to notes."""
    root = spaces.content_dir(_space_id_or_404(db, request.space_id))
    _check_project(db, request.project_id)
    note_paths = list(dict.fromkeys(_link_path(root, p) for p in request.note_paths))
    set_source(db, DESKTOP_SOURCE)
    task = Task(**request.model_dump(exclude={"note_paths"}), is_gantt_task=False)
    if task.status == Status.DONE:
        task.completed_at = utcnow()
    db.add(task)
    db.flush()
    db.add_all(TaskNoteLink(task_id=task.id, note_path=path) for path in note_paths)
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


@app.post("/api/tasks/{task_id}/links")
def link_note(task_id: int, request: TaskNoteLinkIn, db: Session = Depends(get_db)) -> TaskItem:
    """Link a note of the task's space to the task (linking twice is harmless)."""
    task = _get_task(db, task_id)
    path = _link_path(spaces.content_dir(task.space_id or spaces.DEFAULT_SPACE_ID), request.note_path)
    if db.get(TaskNoteLink, (task.id, path)) is None:
        db.add(TaskNoteLink(task_id=task.id, note_path=path))
        db.commit()
    return _task_items(db, [task])[0]


@app.delete("/api/tasks/{task_id}/links")
def unlink_note(task_id: int, note_path: str, db: Session = Depends(get_db)) -> TaskItem:
    task = _get_task(db, task_id)
    db.execute(delete(TaskNoteLink).where(TaskNoteLink.task_id == task.id, TaskNoteLink.note_path == note_path))
    db.commit()
    return _task_items(db, [task])[0]


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
    _check_project(db, request.filters.project_id)
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
        _check_project(db, request.filters.project_id)
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


if __name__ == "__main__":
    import uvicorn

    from config import get_settings

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
