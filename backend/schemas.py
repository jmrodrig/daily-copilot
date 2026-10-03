"""Shared Pydantic models for the Daily Co-Pilot data model.

Structured records (projects, tasks, links, captures, people) are stored in SQLite;
notes and emails live as markdown files with YAML front-matter (see `file_layer`).
"""

from datetime import date, datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AccessMode(str, Enum):
    """How much freedom the agent has when changing a note."""

    READ_ONLY = "read_only"
    ASK_FIRST = "ask_first"
    WRITE_DIRECTLY = "write_directly"


class Status(str, Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    DONE = "done"


class Priority(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class CaptureSource(str, Enum):
    MOBILE = "mobile"
    SHARE_SHEET = "share_sheet"
    DESKTOP = "desktop"
    EMAIL = "email"


class LinkType(str, Enum):
    FINISH_TO_START = "finish_to_start"


class Project(BaseModel):
    id: int | None = None
    code: str = Field(min_length=1, description="Project number, e.g. C7801")
    name: str
    description: str = ""
    active: bool = True
    created_at: datetime | None = None


class Subtask(BaseModel):
    id: int | None = None
    task_id: int | None = None
    title: str = Field(min_length=1)
    status: Status = Status.TODO
    estimate_hours: float | None = Field(default=None, ge=0)
    deadline: date | None = None
    rank: float | None = None
    completed_at: datetime | None = None


class Task(BaseModel):
    id: int | None = None
    project_id: int | None = None
    title: str = Field(min_length=1)
    description: str = ""
    status: Status = Status.TODO
    priority: Priority = Priority.NORMAL
    estimate_hours: float | None = Field(default=None, ge=0)
    start_date: date | None = Field(default=None, description="Planned start from the Gantt")
    deadline: date | None = None
    float_days: float | None = Field(default=None, description="Schedule float from the Gantt")
    rank: float | None = None
    is_gantt_task: bool = Field(default=False, description="True for shop floor Gantt tasks")
    is_milestone: bool = Field(default=False, description="Zero-duration Gantt event")
    subtasks: list[Subtask] = Field(default_factory=list)
    created_at: datetime | None = None
    completed_at: datetime | None = None


class Link(BaseModel):
    """Dependency between two tasks, e.g. a design task feeding a shop floor task."""

    id: int | None = None
    predecessor_id: int
    successor_id: int
    type: LinkType = LinkType.FINISH_TO_START
    lag_days: float = 0


class Person(BaseModel):
    id: int | None = None
    name: str = Field(min_length=1)
    email: str | None = None
    role: str | None = None
    organisation: str | None = None
    projects: list[str] = Field(default_factory=list, description="Project codes")


class Capture(BaseModel):
    id: int | None = None
    text: str = Field(min_length=1)
    source: CaptureSource = CaptureSource.MOBILE
    project_code: str | None = None
    priority: Priority = Priority.NORMAL
    tags: list[str] = Field(default_factory=list)
    processed: bool = False
    created_at: datetime | None = None


class CaptureRequest(BaseModel):
    """A quick note from the Android capture screen (`POST /api/capture`)."""

    content: str = Field(min_length=1)
    # The project becomes a folder name, so only plain codes are allowed (no path separators).
    project: str = Field(default="Inbox", pattern=r"^[A-Za-z0-9_-]+$", max_length=64)
    priority: Priority = Priority.NORMAL

    @field_validator("content")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value

    @field_validator("priority", mode="before")
    @classmethod
    def _lowercase_priority(cls, value: object) -> object:
        """The app sends display labels ("Low", "Normal", "High")."""
        return value.lower() if isinstance(value, str) else value


class CaptureResponse(BaseModel):
    path: str = Field(description="Path of the new note relative to the notes directory")


class GanttTask(BaseModel):
    """One bar (or milestone diamond) on the desktop Gantt chart."""

    id: int
    name: str
    start_date: date | None = Field(description="None when the imported Gantt had no dates for the task")
    end_date: date | None
    completion_percent: float = Field(ge=0, le=100)
    status: Status
    is_milestone: bool


class GanttProject(BaseModel):
    """A swimlane: one project and its Gantt tasks, sorted by start date (undated last)."""

    id: int
    code: str
    name: str
    tasks: list[GanttTask]


class GanttResponse(BaseModel):
    projects: list[GanttProject]


class TriageKind(str, Enum):
    GANTT_TASK = "gantt_task"
    CAPTURE = "capture"


class TriageRank(int, Enum):
    """Morning List buckets, most urgent first."""

    OVERDUE = 1
    TODAY = 2
    CAPTURE_HIGH = 3
    CAPTURE_NORMAL = 4
    UPCOMING = 5
    CAPTURE_LOW = 6


class TriageItem(BaseModel):
    """One entry on the Morning List: an active Gantt task or an unprocessed capture note."""

    id: str = Field(description='"task:<id>" or "note:<path>"')
    kind: TriageKind
    rank: TriageRank
    title: str
    project: str | None = Field(description="Project code; None for Inbox captures")
    priority: Priority
    status: Status | None = Field(default=None, description="Gantt tasks only")
    start_date: date | None = None
    due_date: date | None = None
    created: datetime | None = Field(default=None, description="Capture notes only")
    path: str | None = Field(default=None, description="Capture note path relative to the notes directory")
    content: str | None = None


class Note(BaseModel):
    """A markdown note. Known front-matter keys are typed; unknown keys are kept as extras."""

    model_config = ConfigDict(extra="allow")

    path: str = Field(description="Path relative to the notes directory")
    title: str | None = None
    type: str | None = Field(default=None, description="e.g. wiki, meeting, decision")
    project: str | None = None
    tags: list[str] = Field(default_factory=list)
    people: list[str] = Field(default_factory=list)
    created: date | datetime | None = None
    updated: date | datetime | None = None
    content: str = ""


class Email(BaseModel):
    """An email saved as markdown into the intake drop folder."""

    path: str | None = None
    subject: str = ""
    sender: str
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)
    received_at: datetime | None = None
    project: str | None = None
    priority: Priority = Priority.NORMAL
    attachments: list[str] = Field(default_factory=list)
    body: str = ""
