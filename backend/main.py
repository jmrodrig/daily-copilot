"""FastAPI entry point. Run with `uvicorn main:app --reload` from backend/."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI

import file_layer
from database import init_db
from schemas import AccessMode, CaptureRequest, CaptureResponse

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


if __name__ == "__main__":
    import uvicorn

    from config import get_settings

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
