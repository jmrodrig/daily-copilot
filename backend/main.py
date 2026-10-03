"""FastAPI entry point. Run with `uvicorn main:app --reload` from backend/."""

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime

from fastapi import Depends, FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

import file_layer
from database import get_db, init_db
from models import Project, Task
from schemas import (
    AccessMode,
    CaptureRequest,
    CaptureResponse,
    GanttProject,
    GanttResponse,
    GanttTask,
    Status,
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


if __name__ == "__main__":
    import uvicorn

    from config import get_settings

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
