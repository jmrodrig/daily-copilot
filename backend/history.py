"""Version history: an append-only `history` table of full JSON snapshots, plus soft deletes.

Every insert, update and soft delete of a `Versioned` model is recorded automatically
by session listeners. The actor behind a change is read from `session.info["source"]`
(e.g. "manual", "gemini", "cli_import"); set it with `set_source` before flushing.

Notes are files, not rows, so `file_layer` records their changes itself with `record`.
"""

import datetime as dt
import enum
from typing import Any

from sqlalchemy import event, insert, inspect
from sqlalchemy.orm import Session, with_loader_criteria

from models import HistoryRecord, Project, Task, Versioned

DEFAULT_SOURCE = "manual"
SOURCE_KEY = "source"
_PENDING_DELETES_KEY = "_history_pending_deletes"


def utcnow() -> dt.datetime:
    """Naive UTC, matching SQLite's CURRENT_TIMESTAMP used for `created_at`."""
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


def set_source(session: Session, source: str) -> None:
    """Attribute every change flushed by `session` from now on to `source`."""
    session.info[SOURCE_KEY] = source


def get_source(session: Session) -> str:
    return session.info.get(SOURCE_KEY, DEFAULT_SOURCE)


def to_jsonable(value: Any) -> Any:
    """Convert dates, enums and nested containers into plain JSON values."""
    if isinstance(value, enum.Enum):
        return to_jsonable(value.value)
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def snapshot(obj: Versioned) -> dict[str, Any]:
    """Every column of `obj` as a JSON-compatible dict."""
    return {attr.key: to_jsonable(getattr(obj, attr.key)) for attr in inspect(obj).mapper.column_attrs}


def _entity_id(obj: Versioned) -> str:
    return "-".join(str(v) for v in inspect(obj).mapper.primary_key_from_instance(obj))


def _row(obj: Versioned, action: str, state: dict[str, Any], source: str, when: dt.datetime) -> dict:
    return {
        "entity_type": type(obj).__name__,
        "entity_id": _entity_id(obj),
        "action": action,
        "source": source,
        "timestamp": when,
        "snapshot": state,
    }


def record(
    session: Session,
    entity_type: str,
    entity_id: str,
    action: str,
    state: dict[str, Any],
    source: str | None = None,
) -> HistoryRecord:
    """Add a history entry by hand (for entities that are not ORM rows, such as notes)."""
    entry = HistoryRecord(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        source=source or get_source(session),
        timestamp=utcnow(),
        snapshot=to_jsonable(state),
    )
    session.add(entry)
    return entry


def soft_delete(session: Session, obj: Versioned, when: dt.datetime | None = None) -> None:
    """Mark `obj` deleted instead of removing it, replacing the old ON DELETE CASCADEs.

    Deleting a task also deletes its links; deleting a project also deletes its tasks.
    """
    if obj.deleted_at is not None:
        return
    when = when or utcnow()
    obj.deleted_at = when
    session.add(obj)
    if isinstance(obj, Project):
        children: list[Versioned] = list(obj.tasks)
    elif isinstance(obj, Task):
        children = [*obj.successor_links, *obj.predecessor_links]
    else:
        children = []
    for child in children:
        soft_delete(session, child, when)


def restore(obj: Versioned) -> None:
    """Undo a soft delete of `obj` (its children stay deleted)."""
    obj.deleted_at = None


# --- Session listeners --------------------------------------------------------


@event.listens_for(Session, "do_orm_execute")
def _hide_soft_deleted(state) -> None:
    """Leave soft-deleted rows out of ORM queries and relationship loads."""
    if (
        state.is_select
        and not state.is_column_load
        and not state.execution_options.get("include_deleted", False)
    ):
        state.statement = state.statement.options(
            with_loader_criteria(Versioned, lambda cls: cls.deleted_at.is_(None), include_aliases=True)
        )


@event.listens_for(Session, "before_flush")
def _capture_hard_deletes(session: Session, _flush_context, _instances) -> None:
    """Snapshot rows removed with `session.delete()` while their state can still be loaded."""
    session.info[_PENDING_DELETES_KEY] = [
        (obj, snapshot(obj)) for obj in session.deleted if isinstance(obj, Versioned)
    ]


@event.listens_for(Session, "after_flush")
def _write_history(session: Session, _flush_context) -> None:
    source, when = get_source(session), utcnow()
    rows = [_row(obj, "create", snapshot(obj), source, when) for obj in session.new if isinstance(obj, Versioned)]

    for obj in session.dirty:
        if not isinstance(obj, Versioned) or not session.is_modified(obj, include_collections=False):
            continue
        added, _unchanged, removed = inspect(obj).attrs.deleted_at.history
        if added and added[0] is not None and (not removed or removed[0] is None):
            action = "delete"
        else:
            action = "update"
        rows.append(_row(obj, action, snapshot(obj), source, when))

    rows.extend(_row(obj, "delete", state, source, when) for obj, state in session.info.pop(_PENDING_DELETES_KEY, []))

    if rows:
        session.connection().execute(insert(HistoryRecord), rows)

