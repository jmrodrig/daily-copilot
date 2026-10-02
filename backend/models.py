"""SQLAlchemy ORM models for the structured records in `schemas.py`.

Column names mirror the Pydantic schemas so rows can be validated with
`schemas.Task.model_validate(row, from_attributes=True)` and friends.

Rows are never removed: `Versioned` models are soft-deleted by setting `deleted_at`
(see `history.soft_delete`), and every change is recorded in the `history` table.
"""

import datetime as dt
import enum

from sqlalchemy import JSON, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base
from schemas import LinkType, Priority, Status


def _str_enum(enum_cls: type[enum.Enum]) -> Enum:
    """Store enums by value (e.g. "in_progress") as plain strings, not native enums."""
    return Enum(
        enum_cls,
        values_callable=lambda members: [member.value for member in members],
        native_enum=False,
        length=32,
    )


class Versioned:
    """Mixin for models whose changes are recorded in `history` and that are soft-deleted.

    Soft-deleted rows are hidden from ORM queries unless the query is run with
    `.execution_options(include_deleted=True)`.
    """

    # Fetch server defaults (e.g. `created_at`) on insert so history snapshots are complete.
    __mapper_args__ = {"eager_defaults": True}

    deleted_at: Mapped[dt.datetime | None] = mapped_column(default=None, index=True)


class Project(Versioned, Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())

    # passive_deletes="all": a hard delete is refused by the foreign key instead of
    # orphaning the tasks; use `history.soft_delete`.
    tasks: Mapped[list["Task"]] = relationship(back_populates="project", passive_deletes="all")

    def __repr__(self) -> str:
        return f"Project(id={self.id!r}, code={self.code!r})"


class Task(Versioned, Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    status: Mapped[Status] = mapped_column(_str_enum(Status), default=Status.TODO)
    priority: Mapped[Priority] = mapped_column(_str_enum(Priority), default=Priority.NORMAL)
    estimate_hours: Mapped[float | None]
    start_date: Mapped[dt.date | None]
    deadline: Mapped[dt.date | None]
    float_days: Mapped[float | None]
    rank: Mapped[float | None]
    is_gantt_task: Mapped[bool] = mapped_column(default=False, index=True)
    is_milestone: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    completed_at: Mapped[dt.datetime | None]

    project: Mapped[Project | None] = relationship(back_populates="tasks")
    # No delete cascades: soft-deleting a task soft-deletes its links (see `history.soft_delete`).
    successor_links: Mapped[list["Link"]] = relationship(
        foreign_keys="Link.predecessor_id", back_populates="predecessor", passive_deletes="all"
    )
    predecessor_links: Mapped[list["Link"]] = relationship(
        foreign_keys="Link.successor_id", back_populates="successor", passive_deletes="all"
    )

    def __repr__(self) -> str:
        return f"Task(id={self.id!r}, title={self.title!r})"


class Link(Versioned, Base):
    """Finish-to-start dependency: `predecessor` must finish before `successor` starts."""

    __tablename__ = "links"
    __table_args__ = (UniqueConstraint("predecessor_id", "successor_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    predecessor_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), index=True)
    successor_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), index=True)
    type: Mapped[LinkType] = mapped_column(_str_enum(LinkType), default=LinkType.FINISH_TO_START)
    lag_days: Mapped[float] = mapped_column(default=0)

    predecessor: Mapped[Task] = relationship(
        foreign_keys=[predecessor_id], back_populates="successor_links"
    )
    successor: Mapped[Task] = relationship(
        foreign_keys=[successor_id], back_populates="predecessor_links"
    )

    def __repr__(self) -> str:
        return f"Link({self.predecessor_id!r} -> {self.successor_id!r})"


class HistoryRecord(Base):
    """One entry in the append-only audit trail: the full state of an entity after a change.

    `entity_id` is the primary key for database rows and the path relative to
    NOTES_DIR for notes. For deletes the snapshot is the last state before deletion.
    """

    __tablename__ = "history"

    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(index=True)
    action: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(String(64))
    timestamp: Mapped[dt.datetime] = mapped_column(index=True)
    snapshot: Mapped[dict] = mapped_column(JSON)

    def __repr__(self) -> str:
        return f"HistoryRecord({self.action!r} {self.entity_type}:{self.entity_id})"


import history  # noqa: E402,F401  -- registers the session listeners that write `history`
