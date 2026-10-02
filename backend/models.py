"""SQLAlchemy ORM models for the structured records in `schemas.py`.

Column names mirror the Pydantic schemas so rows can be validated with
`schemas.Task.model_validate(row, from_attributes=True)` and friends.
"""

import datetime as dt
import enum

from sqlalchemy import Enum, ForeignKey, String, UniqueConstraint, func
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


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())

    tasks: Mapped[list["Task"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )

    def __repr__(self) -> str:
        return f"Project(id={self.id!r}, code={self.code!r})"


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
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
    # Links are owned by the database cascade (ON DELETE CASCADE on both ends).
    successor_links: Mapped[list["Link"]] = relationship(
        foreign_keys="Link.predecessor_id",
        back_populates="predecessor",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    predecessor_links: Mapped[list["Link"]] = relationship(
        foreign_keys="Link.successor_id",
        back_populates="successor",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return f"Task(id={self.id!r}, title={self.title!r})"


class Link(Base):
    """Finish-to-start dependency: `predecessor` must finish before `successor` starts."""

    __tablename__ = "links"
    __table_args__ = (UniqueConstraint("predecessor_id", "successor_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    predecessor_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    successor_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
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
