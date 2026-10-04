"""Shared Pydantic models for the Daily Co-Pilot data model.

Structured records (projects, tasks, links, captures, people) are stored in SQLite;
notes and emails live as markdown files with YAML front-matter (see `file_layer`).
"""

import re
from datetime import date, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AccessMode(str, Enum):
    """How much freedom the agent has when changing a note."""

    READ_ONLY = "read_only"
    ASK_FIRST = "ask_first"
    WRITE_DIRECTLY = "write_directly"


class Status(str, Enum):
    BACKLOG = "backlog"
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
    space_id: int | None = None
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
    assignee: str | None = Field(default=None, description="Who has claimed the task; None if unclaimed")
    subtasks: list[Subtask] = Field(default_factory=list)
    created_at: datetime | None = None
    completed_at: datetime | None = None


class TaskUpdate(BaseModel):
    """`PATCH /api/tasks/{id}`: only the fields sent are changed; `assignee: null` unclaims."""

    assignee: str | None = Field(default=None, max_length=64)
    status: Status | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    priority: Priority | None = None
    project_id: int | None = Field(default=None, description="null removes the task from its project")
    start_date: date | None = None
    deadline: date | None = None

    @field_validator("assignee")
    @classmethod
    def _blank_is_unassigned(cls, value: str | None) -> str | None:
        return (value.strip() or None) if value is not None else None

    @field_validator("status", "title", "description", "priority")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("cannot be null")
        return value

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must not be blank")
        return value.strip()


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
    source: str | None = Field(default=None, pattern=r"^[A-Za-z0-9 _-]+$", max_length=32, description='e.g. "verbal", "meeting"')
    space_id: int = Field(default=1, description="Space whose content/ receives the note")

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
    assignee: str | None = Field(default=None, description="Gantt tasks only; who has claimed the task")
    start_date: date | None = None
    due_date: date | None = None
    created: datetime | None = Field(default=None, description="Capture notes only")
    path: str | None = Field(default=None, description="Capture note path relative to the notes directory")
    content: str | None = None


class TimeEntry(BaseModel):
    """One time sheet row from the evening check-in."""

    # None, "Inbox" or "Overhead" log the time without a project.
    project: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]+$", max_length=32)
    hours: float = Field(gt=0, le=24)
    notes: str = ""


class CheckInRequest(BaseModel):
    """`POST /api/checkin`: tasks finished today and the day's time sheet."""

    completed_task_ids: list[int] = Field(default_factory=list)
    time_entries: list[TimeEntry] = Field(default_factory=list)
    day: date | None = Field(default=None, description="Day the hours are logged against; defaults to today")


class CheckInResponse(BaseModel):
    completed_task_ids: list[int]
    time_log_ids: list[int]
    total_hours: float


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


class ChatRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(BaseModel):
    role: ChatRole
    content: str


class ChatRequest(BaseModel):
    """`POST /api/chat`: the whole conversation so far (the server keeps no chat state)."""

    messages: list[ChatMessage] = Field(min_length=1)
    access_mode: AccessMode = AccessMode.ASK_FIRST
    space_id: int = Field(default=1, description="The active space: the agent only sees its notes and tasks")
    note_path: str | None = Field(default=None, description="The note the user has open, relative to content/")

    @field_validator("messages")
    @classmethod
    def _ends_with_user(cls, value: list[ChatMessage]) -> list[ChatMessage]:
        if value[-1].role != ChatRole.USER or not value[-1].content.strip():
            raise ValueError("the last message must be a non-blank user message")
        return value


class SavedPromptIn(BaseModel):
    """`POST /api/prompts` and `PUT /api/prompts/{id}`: a slash command and the instruction it sends."""

    command: str = Field(description='e.g. "/prep"; the leading slash is optional')
    description: str = Field(default="", max_length=200, description="One line shown in the chat's command menu")
    instruction: str = Field(min_length=1, description="What the agent is told to do when the command is used")

    @field_validator("command")
    @classmethod
    def _normalise_command(cls, value: str) -> str:
        command = "/" + value.strip().lstrip("/").lower()
        if not re.fullmatch(r"/[a-z0-9][a-z0-9_-]{0,30}", command):
            raise ValueError("command must be a slash and up to 31 letters, digits, '-' or '_', e.g. /prep")
        return command

    @field_validator("description")
    @classmethod
    def _strip_description(cls, value: str) -> str:
        return value.strip()

    @field_validator("instruction")
    @classmethod
    def _instruction_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("instruction must not be blank")
        return value.strip()


class SavedPrompt(SavedPromptIn):
    id: int
    created_at: datetime | None = None


class NoteSummary(BaseModel):
    """One entry in the desktop page tree (`GET /api/notes`)."""

    path: str = Field(description="Path relative to the notes directory")
    title: str


class NoteFile(BaseModel):
    """`GET /api/notes/file`: a note as stored on disk."""

    path: str
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    content: str


class NoteState(str, Enum):
    """A note's `state` front-matter: drafts are edited in the desktop app, published notes are read-only there.

    A note without `state` is published (notes written before Phase 9.3); new notes start as drafts.
    """

    DRAFT = "draft"
    PUBLISHED = "published"


class NoteUpdate(BaseModel):
    """`PUT /api/notes/file`: save a note's body and/or set its state. Other front-matter is kept."""

    space_id: int
    path: str = Field(min_length=1, description="Relative to content/")
    content: str | None = Field(default=None, description="The new body (without front-matter); unchanged if omitted")
    state: NoteState | None = Field(default=None, description="Unchanged if omitted")
    title: str | None = Field(default=None, description="The new front-matter `title`; unchanged if omitted")

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("title must not be blank")
        return None if value is None else value.strip()


class ImageUpload(BaseModel):
    """`POST /api/notes/image`: where a pasted image is served from, for the note's markdown."""

    url: str


class ProposedEdit(BaseModel):
    """A note write the agent wanted to make in `ask_first` mode, waiting for the user's approval."""

    path: str = Field(description="Path relative to the notes directory")
    content: str
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    previous_content: str | None = Field(description="Current content on disk; None for a new note")
    previous_frontmatter: dict[str, Any] | None = None
    base_hash: str | None = Field(
        description="SHA-256 of the note file when the edit was proposed; None for a new note"
    )


class ToolCallSummary(BaseModel):
    """One tool call the agent made while answering, for display in the chat."""

    name: str
    arguments: dict[str, Any]
    ok: bool


class ChatResponse(BaseModel):
    reply: str
    proposed_edits: list[ProposedEdit] = Field(default_factory=list)
    written_paths: list[str] = Field(default_factory=list, description="Notes written (write_directly mode)")
    tool_calls: list[ToolCallSummary] = Field(default_factory=list)


class ApplyEditRequest(BaseModel):
    """`POST /api/notes/apply-edit`: commit a `ProposedEdit` the user approved."""

    space_id: int = 1
    path: str
    content: str
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    base_hash: str | None = None


class ApplyEditResponse(BaseModel):
    path: str
    written: bool = Field(description="False if the note already had exactly this text")


# --- Spaces, content tree and the task engine (Phase 9) ------------------------


class NoteRoot(str, Enum):
    """The two folders of a space: the notes and the note templates."""

    CONTENT = "content"
    TEMPLATES = "templates"


class SpaceIn(BaseModel):
    """`POST /api/spaces`."""

    name: str = Field(min_length=1, max_length=64)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must not be blank")
        return value.strip()


class Space(SpaceIn):
    id: int
    created_at: datetime | None = None


class FolderNode(BaseModel):
    """A folder in a space's `content/` tree with its sub-folders and notes (`GET /api/tree`)."""

    name: str
    path: str = Field(description="Relative to content/; empty for the root")
    is_project: bool = False
    is_reference: bool = False
    project_id: int | None = Field(default=None, description="The linked Project (its tasks) when is_project")
    folders: list["FolderNode"] = Field(default_factory=list)
    notes: list[NoteSummary] = Field(default_factory=list)


class TreeResponse(BaseModel):
    space_id: int
    content: FolderNode
    templates: list[NoteSummary] = Field(default_factory=list)


class FolderMetaUpdate(BaseModel):
    """`PUT /api/folders/meta`: mark a folder as a Project and/or Reference Data. Unsent flags are kept."""

    space_id: int
    path: str = Field(min_length=1)
    is_project: bool | None = None
    is_reference: bool | None = None


class FolderMetaOut(BaseModel):
    space_id: int
    path: str
    is_project: bool
    is_reference: bool
    project_id: int | None = None


class FolderCreate(BaseModel):
    """`POST /api/folders`: create an (empty) folder under content/."""

    space_id: int
    path: str = Field(min_length=1)


class NoteCreate(BaseModel):
    """`POST /api/notes`: a new note in content/, optionally scaffolded from a template."""

    space_id: int
    path: str = Field(min_length=1, description="Relative to content/; `.md` is added if missing")
    template: str | None = Field(default=None, description="Template path relative to templates/")
    title: str | None = Field(default=None, max_length=200)


class ContentKind(str, Enum):
    NOTE = "note"
    FOLDER = "folder"


class ContentMove(BaseModel):
    """`POST /api/content/move`: move a note or folder into another folder, keeping its name."""

    space_id: int
    path: str = Field(min_length=1, description="The note or folder, relative to content/")
    destination: str = Field(default="", description="The folder to move it into; empty for content/ itself")


class ContentRename(BaseModel):
    """`POST /api/content/rename`: rename a note or folder in place."""

    space_id: int
    path: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=200, description="The new name; a note keeps its `.md`")

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        value = value.strip()
        if not value or value.startswith(".") or re.search(r"[\\/]", value):
            raise ValueError("a name cannot be empty, start with a dot or contain / or \\")
        return value


class ContentRef(BaseModel):
    """`POST /api/content/duplicate`: a note or folder of a space."""

    space_id: int
    path: str = Field(min_length=1)


class ContentEntry(BaseModel):
    """A note or folder after a move, rename or duplicate."""

    kind: ContentKind
    path: str = Field(description="Relative to content/")


class ProjectOption(BaseModel):
    """A project available in a space, for task filters and pickers (`GET /api/projects`)."""

    id: int
    code: str
    name: str
    folder_path: str | None = Field(default=None, description="The project folder in this space, if any")


class TaskCreate(BaseModel):
    """`POST /api/tasks`: a task in the database-backed task engine."""

    space_id: int
    project_id: int | None = None
    title: str = Field(min_length=1, max_length=500)
    description: str = ""
    status: Status = Status.BACKLOG
    priority: Priority = Priority.NORMAL
    start_date: date | None = None
    deadline: date | None = Field(default=None, description="Due date")
    assignee: str | None = Field(default=None, max_length=64)
    note_paths: list[str] = Field(default_factory=list, description="Notes to link, relative to content/")

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must not be blank")
        return value.strip()

    @field_validator("assignee")
    @classmethod
    def _blank_is_unassigned(cls, value: str | None) -> str | None:
        return (value.strip() or None) if value is not None else None


class TaskItem(BaseModel):
    """A task as shown on the Kanban, Backlog and Gantt views (`GET /api/tasks`)."""

    id: int
    space_id: int
    project_id: int | None
    project_code: str | None
    title: str
    description: str
    status: Status
    priority: Priority
    assignee: str | None
    start_date: date | None
    deadline: date | None
    completion_percent: float
    is_gantt_task: bool
    is_milestone: bool
    note_paths: list[str] = Field(default_factory=list)


class TaskNoteLinkIn(BaseModel):
    note_path: str = Field(min_length=1)


class ViewType(str, Enum):
    KANBAN = "kanban"
    BACKLOG = "backlog"
    GANTT = "gantt"


class TaskViewFilters(BaseModel):
    """The filters a saved task view applies to `GET /api/tasks`."""

    project_id: int | None = Field(default=None, description="None means every project")
    assignee: str | None = Field(default=None, max_length=64, description='None means everyone; "" means unassigned')

    @field_validator("assignee")
    @classmethod
    def _strip_assignee(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class TaskViewIn(BaseModel):
    """`POST /api/views`: a named Kanban, Backlog or Gantt view of a space's tasks."""

    space_id: int
    name: str = Field(min_length=1, max_length=64)
    view_type: ViewType
    filters: TaskViewFilters = Field(default_factory=TaskViewFilters)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must not be blank")
        return value.strip()


class TaskViewUpdate(BaseModel):
    """`PUT /api/views/{id}`: rename a view and/or replace its filters. Unsent fields are kept."""

    name: str | None = Field(default=None, min_length=1, max_length=64)
    filters: TaskViewFilters | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("name must not be blank")
        return value.strip() if value is not None else None


class TaskView(TaskViewIn):
    id: int
    created_at: datetime | None = None
