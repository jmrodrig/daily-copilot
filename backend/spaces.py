"""Spaces: the top-level boundary for notes, folders and tasks.

Each space has its own folder under `<data_dir>/spaces/<space_id>/`:

- `content/`: the free-form folder tree of markdown notes (Confluence-style).
- `templates/`: markdown templates used to scaffold new notes.

Folders under `content/` can be marked as a Project (Epic) and/or Reference Data;
those flags live in the `folder_meta` table (see `models.FolderMeta`).
"""

import logging
import shutil
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

import file_layer
from config import get_settings
from history import set_source
from models import FolderMeta, Project, Space, Task
from schemas import FolderNode, NoteRoot, NoteSummary

log = logging.getLogger(__name__)

DEFAULT_SPACE_ID = 1
DEFAULT_SPACE_NAME = "Default"
MIGRATION_SOURCE = "phase9_migration"
SPACES_SOURCE = "desktop"
_CODE_MAX = 32  # `Project.code` length
_TITLE_MAX = 100

# Starter templates for a new space's templates/ folder.
DEFAULT_TEMPLATES = {
    "Meeting note.md": (
        "---\ntype: meeting\n---\n# {title}\n\n**Date:** \n**Attendees:** \n\n"
        "## Agenda\n\n- \n\n## Notes\n\n## Decisions\n\n## Action items\n\n- [ ] \n"
    ),
    "Design decision.md": (
        "---\ntype: decision\nstatus: proposed\n---\n# {title}\n\n"
        "## Context\n\n## Options\n\n1. \n\n## Decision\n\n## Consequences\n"
    ),
}


# --- Paths --------------------------------------------------------------------


def spaces_root() -> Path:
    return (get_settings().data_dir / "spaces").resolve()


def space_dir(space_id: int) -> Path:
    return spaces_root() / str(int(space_id))


def content_dir(space_id: int = DEFAULT_SPACE_ID) -> Path:
    return space_dir(space_id) / NoteRoot.CONTENT.value


def templates_dir(space_id: int = DEFAULT_SPACE_ID) -> Path:
    return space_dir(space_id) / NoteRoot.TEMPLATES.value


def root_dir(space_id: int, root: NoteRoot = NoteRoot.CONTENT) -> Path:
    return content_dir(space_id) if root is NoteRoot.CONTENT else templates_dir(space_id)


def normalize_folder(space_id: int, folder: str) -> str:
    """`folder` as a clean posix path relative to content/, refusing anything that escapes it."""
    root = content_dir(space_id).resolve()
    path = (root / folder.strip().strip("/")).resolve()
    if not path.is_relative_to(root) or path == root:
        raise file_layer.NotePathError(f"{folder} is outside the content folder")
    rel = path.relative_to(root).as_posix()
    if any(part.startswith(".") for part in rel.split("/")):
        raise file_layer.NotePathError(f"{folder} is a hidden folder")
    return rel


def ensure_space_dirs(space_id: int) -> None:
    """Create a space's content/ and templates/ folders; a new templates/ gets the starter templates."""
    content_dir(space_id).mkdir(parents=True, exist_ok=True)
    templates = templates_dir(space_id)
    if not templates.exists():
        templates.mkdir(parents=True)
        for name, text in DEFAULT_TEMPLATES.items():
            (templates / name).write_text(text, encoding="utf-8", newline="\n")


# --- Startup migration --------------------------------------------------------


def _has_entries(path: Path) -> bool:
    return path.is_dir() and any(path.iterdir())


def migrate(db: Session) -> None:
    """Bring a pre-Phase 9 install onto Spaces. Safe to run on every startup.

    - Creates the "Default" space (id 1) if there is none.
    - Moves the legacy notes folder (`COPILOT_NOTES_DIR`) to `data/spaces/1/content/`.
      Note paths relative to the root are unchanged, so their history still lines up.
    - Puts tasks without a space into the Default space.
    - Creates content/ and templates/ for every space.
    """
    set_source(db, MIGRATION_SOURCE)
    if db.get(Space, DEFAULT_SPACE_ID) is None:
        db.add(Space(id=DEFAULT_SPACE_ID, name=DEFAULT_SPACE_NAME))
        db.flush()

    legacy, target = get_settings().notes_dir, content_dir(DEFAULT_SPACE_ID)
    if legacy.is_dir() and legacy.resolve() != target.resolve():
        if _has_entries(target):
            if _has_entries(legacy):
                log.warning("Not moving %s: %s already has notes. Merge them by hand.", legacy, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.rmdir()  # empty
            shutil.move(str(legacy), str(target))
            log.info("Moved the notes from %s to %s", legacy, target)

    db.execute(
        update(Task)
        .where(Task.space_id.is_(None))
        .values(space_id=DEFAULT_SPACE_ID)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    for space in db.scalars(select(Space)).all():
        ensure_space_dirs(space.id)


# --- Spaces -------------------------------------------------------------------


def get_space(db: Session, space_id: int) -> Space | None:
    space = db.get(Space, space_id)
    return space if space is not None and space.deleted_at is None else None


def create_space(db: Session, name: str) -> Space:
    set_source(db, SPACES_SOURCE)
    space = Space(name=name)
    db.add(space)
    db.commit()
    ensure_space_dirs(space.id)
    return space


# --- Folder metadata ----------------------------------------------------------


def folder_metas(db: Session, space_id: int) -> dict[str, FolderMeta]:
    """Folder metadata of a space by path."""
    return {meta.path: meta for meta in db.scalars(select(FolderMeta).where(FolderMeta.space_id == space_id))}


def _project_for_folder(db: Session, path: str) -> Project:
    """The project a newly marked folder stands for: the one with the folder's name as its code
    (e.g. an imported Gantt), unless another folder already claims it; otherwise a new one."""
    name = path.rsplit("/", 1)[-1]
    base = name[:_CODE_MAX]
    taken = set(db.scalars(select(FolderMeta.project_id).where(FolderMeta.project_id.is_not(None))))
    candidate, n = base, 1
    while True:
        project = db.scalars(
            select(Project).where(func.upper(Project.code) == candidate.upper()).execution_options(include_deleted=True)
        ).first()
        if project is None:
            project = Project(code=candidate, name=name)
            db.add(project)
            db.flush()
            return project
        if project.id not in taken and project.deleted_at is None:
            return project
        n += 1
        suffix = f"-{n}"
        candidate = base[: _CODE_MAX - len(suffix)] + suffix


def set_folder_meta(
    db: Session, space_id: int, path: str, *, is_project: bool | None = None, is_reference: bool | None = None
) -> FolderMeta:
    """Mark or unmark a folder as a Project / Reference Data. A project folder is linked to a `Project`."""
    path = normalize_folder(space_id, path)
    if not (content_dir(space_id) / path).is_dir():
        raise FileNotFoundError(f"No folder at {path}")
    set_source(db, SPACES_SOURCE)
    meta = db.scalars(select(FolderMeta).where(FolderMeta.space_id == space_id, FolderMeta.path == path)).first()
    if meta is None:
        meta = FolderMeta(space_id=space_id, path=path, is_project=False, is_reference=False)
        db.add(meta)
    if is_project is not None:
        meta.is_project = is_project
    if is_reference is not None:
        meta.is_reference = is_reference
    if meta.is_project and (meta.project is None or meta.project.deleted_at is not None):
        meta.project = _project_for_folder(db, path)
    db.commit()
    return meta


def project_folder_for(metas: dict[str, FolderMeta], note_path: str) -> FolderMeta | None:
    """The nearest enclosing project folder of a note (path relative to content/)."""
    parts = note_path.strip("/").split("/")[:-1]
    for i in range(len(parts), 0, -1):
        meta = metas.get("/".join(parts[:i]))
        if meta is not None and meta.is_project:
            return meta
    return None


def reference_folders(db: Session, space_id: int) -> list[str]:
    return sorted(path for path, meta in folder_metas(db, space_id).items() if meta.is_reference)


# --- Tree ---------------------------------------------------------------------


def note_title(content: str) -> str:
    """The first non-blank line of a note, without heading marks."""
    line = next((ln.strip() for ln in content.splitlines() if ln.strip()), "(empty note)")
    line = line.lstrip("#").strip() or line
    return line if len(line) <= _TITLE_MAX else line[: _TITLE_MAX - 1] + "…"


def note_summary(path: str, root: Path) -> NoteSummary:
    """Display title: front-matter `title`, else the first line, else the file name."""
    try:
        note = file_layer.read_note(path, notes_dir=root)
        title = str(note["frontmatter"].get("title") or "").strip() or note_title(note["content"])
    except (file_layer.FileLayerError, OSError, UnicodeDecodeError):
        title = ""
    if not title or title == "(empty note)":
        title = path.rsplit("/", 1)[-1].removesuffix(file_layer.NOTE_SUFFIX)
    return NoteSummary(path=path, title=title)


def _sort_key(name: str) -> tuple[str, str]:
    return (name.lower(), name)


def build_tree(space_id: int, metas: dict[str, FolderMeta]) -> FolderNode:
    """The content/ folder tree, empty folders included; hidden files and folders are skipped."""
    root_path = content_dir(space_id)

    def walk(folder: Path, rel: str) -> FolderNode:
        meta = metas.get(rel)
        node = FolderNode(
            name=folder.name if rel else "",
            path=rel,
            is_project=bool(meta and meta.is_project),
            is_reference=bool(meta and meta.is_reference),
            project_id=meta.project_id if meta and meta.is_project else None,
        )
        try:
            entries = sorted(folder.iterdir(), key=lambda p: _sort_key(p.name))
        except OSError:
            return node
        for entry in entries:
            if entry.name.startswith("."):
                continue
            child = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir():
                node.folders.append(walk(entry, child))
            elif entry.is_file() and entry.suffix.lower() == file_layer.NOTE_SUFFIX:
                node.notes.append(note_summary(child, root_path))
        return node

    return walk(root_path, "") if root_path.is_dir() else FolderNode(name="", path="")


def list_templates(space_id: int) -> list[NoteSummary]:
    """The templates of a space, titled by file name (their first line is usually a `{title}` placeholder)."""
    root = templates_dir(space_id)
    if not root.is_dir():
        return []
    paths = file_layer.list_notes("**/*.md", notes_dir=root)
    return [
        NoteSummary(path=p, title=p.removesuffix(file_layer.NOTE_SUFFIX))
        for p in sorted(paths, key=_sort_key)
        if not any(part.startswith(".") for part in p.split("/"))
    ]
