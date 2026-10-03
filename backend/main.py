"""FastAPI entry point. Run with `uvicorn main:app --reload` from backend/."""

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import file_layer
from database import get_db, init_db
from history import set_source, utcnow
from models import Project, Task, TimeLog
import schemas
from schemas import (
    AccessMode,
    CaptureRequest,
    CaptureResponse,
    CheckInRequest,
    CheckInResponse,
    GanttProject,
    GanttResponse,
    GanttTask,
    Priority,
    Status,
    TaskUpdate,
    TriageItem,
    TriageKind,
    TriageRank,
)

INBOX = "Inbox"
CAPTURE_SOURCE = "android_app"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(title="Daily Co-Pilot Backend", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _capture_path(project: str, now: datetime) -> str:
    """`Inbox/Capture_<ts>.md` or `<project>/Notes-in/Capture_<ts>.md`, never an existing file."""
    folder = INBOX if project.lower() == INBOX.lower() else f"{project}/Notes-in"
    stem = f"{folder}/Capture_{now:%Y%m%d_%H%M%S}"
    path, n = f"{stem}.md", 1
    while file_layer.resolve_note_path(path).exists():
        n += 1
        path = f"{stem}_{n}.md"
    return path


@app.post("/api/capture")
def capture(request: CaptureRequest) -> CaptureResponse:
    """Save a quick note from the Android app as a markdown file."""
    now = datetime.now().replace(microsecond=0)
    path = _capture_path(request.project, now)
    frontmatter = {
        "type": "capture",
        "project": request.project,
        "priority": request.priority.value,
        "created": now.isoformat(),
    }
    # The capture is the user's own new note, so it is written without an approval step.
    file_layer.write_note(path, request.content, frontmatter, AccessMode.WRITE_DIRECTLY, source=CAPTURE_SOURCE)
    return CaptureResponse(path=path)


# `cli_import` writes "Complete: 40%" into the description; older imports wrote " |  | 40%".
_PERCENT_RE = re.compile(r"(?:Complete:|\|)\s*(\d+(?:\.\d+)?)%")


def _completion_percent(task: Task) -> float:
    if task.status == Status.DONE:
        return 100.0
    match = _PERCENT_RE.search(task.description or "")
    return min(float(match.group(1)), 100.0) if match else 0.0


def _gantt_sort_key(task: Task) -> tuple[bool, date, int]:
    return (task.start_date is None, task.start_date or date.min, task.id)


@app.get("/api/gantt")
def gantt(db: Session = Depends(get_db)) -> GanttResponse:
    """Active projects with their shop floor Gantt tasks, for the desktop Gantt chart."""
    projects = db.scalars(select(Project).where(Project.active.is_(True)).order_by(Project.code)).all()
    tasks = db.scalars(
        select(Task).where(Task.is_gantt_task.is_(True), Task.project_id.in_([p.id for p in projects]))
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
                        completion_percent=_completion_percent(task),
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
_TITLE_MAX = 100


def _today() -> date:
    return date.today()


def _gantt_rank(task: Task, today: date) -> TriageRank:
    if task.start_date > today:
        return TriageRank.UPCOMING
    if task.deadline is not None and task.deadline < today:
        return TriageRank.OVERDUE
    return TriageRank.TODAY


def _triage_tasks(db: Session, today: date) -> list[tuple[tuple, TriageItem]]:
    """Unfinished Gantt tasks of active projects that have started or start within the lookahead."""
    rows = db.execute(
        select(Task, Project.code)
        .join(Project, Task.project_id == Project.id)
        .where(
            Project.active.is_(True),
            Task.is_gantt_task.is_(True),
            Task.status != Status.DONE,
            Task.start_date.is_not(None),
            Task.start_date <= today + timedelta(days=TRIAGE_LOOKAHEAD_DAYS),
        )
    ).all()
    items = []
    for task, code in rows:
        if _completion_percent(task) >= 100:
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


def _note_title(content: str) -> str:
    line = next((ln.strip() for ln in content.splitlines() if ln.strip()), "(empty note)")
    line = line.lstrip("#").strip() or line
    return line if len(line) <= _TITLE_MAX else line[: _TITLE_MAX - 1] + "…"


def _note_project(frontmatter: dict[str, Any], path: str) -> str | None:
    """The front-matter project, falling back to the folder; the Inbox means no project."""
    project = str(frontmatter.get("project") or path.split("/")[0])
    return None if project.lower() == INBOX.lower() else project


def _triage_notes() -> list[tuple[tuple, TriageItem]]:
    items = []
    paths = sorted({path for pattern in TRIAGE_NOTE_GLOBS for path in file_layer.list_notes(pattern)})
    for path in paths:
        try:
            note = file_layer.read_note(path)
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
def triage(db: Session = Depends(get_db)) -> list[TriageItem]:
    """The Morning List: active Gantt tasks and capture notes, ranked by `TriageRank`."""
    today = _today()
    ranked = _triage_tasks(db, today) + _triage_notes()
    ranked.sort(key=lambda pair: (pair[1].rank, pair[0]))
    return [item for _key, item in ranked]


TASK_UPDATE_SOURCE = "desktop"


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, request: TaskUpdate, db: Session = Depends(get_db)) -> schemas.Task:
    """Claim or unclaim a task (`assignee`) and/or change its status. Unsent fields are left alone."""
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Unknown task id: {task_id}")
    set_source(db, TASK_UPDATE_SOURCE)
    changes = request.model_dump(exclude_unset=True)
    if "assignee" in changes:
        task.assignee = changes["assignee"]
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


if __name__ == "__main__":
    import uvicorn

    from config import get_settings

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
