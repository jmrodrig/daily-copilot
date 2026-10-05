"""Markdown file layer: read and write notes with YAML front-matter under NOTES_DIR.

NOTES_DIR is a space's `content/` (or `templates/`) folder, passed as `notes_dir`;
it defaults to the Default space's `content/` (see `spaces`).

The agent access mode is enforced here, server-side, so no caller can bypass it:

- `read_only`: writes are refused with `AccessDeniedError`.
- `ask_first`: writes raise `ApprovalRequiredError` (carrying the proposed change)
  unless the caller passes `approved=True` after the user has confirmed.
- `write_directly`: writes go straight to disk.

Every write, rename, copy and delete (of a note, or of every note in a moved, copied or
deleted folder) is recorded in the `history` table (entity type
"Note", entity id = path relative to the Default space's `content/`, or
`spaces/<id>/<content|templates>/<path>` for other folders) with a full snapshot of the note,
so an overwritten or deleted note can always be recovered.
"""

import functools
import hashlib
import os
import re
import shutil
import tempfile
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy.engine import Engine

import database
import history
from schemas import AccessMode

NOTE_SUFFIX = ".md"

# Front-matter is a `---` line at the very start of the file, YAML, then a closing `---` line.
_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)^---[ \t]*(?:\r?\n|\Z)", re.DOTALL | re.MULTILINE)


class FileLayerError(Exception):
    """Base class for file layer errors."""


class NotePathError(FileLayerError, ValueError):
    """The path is outside NOTES_DIR or is not a markdown file."""


class FrontMatterError(FileLayerError, ValueError):
    """The front-matter is not valid YAML or not a mapping."""


class AccessModeError(FileLayerError, PermissionError):
    """The access mode does not allow this write."""


class AccessDeniedError(AccessModeError):
    """Write attempted in `read_only` mode."""


class ApprovalRequiredError(AccessModeError):
    """Change attempted in `ask_first` mode without user approval.

    `action` is "write", "rename" or "delete"; for renames `new_path` is the destination.
    """

    def __init__(
        self,
        path: Path,
        content: str,
        frontmatter: dict[str, Any],
        *,
        action: str = "write",
        new_path: Path | None = None,
    ):
        verb = {"write": "Writing", "rename": "Renaming", "delete": "Deleting"}[action]
        super().__init__(f"{verb} {path} requires user approval")
        self.path = path
        self.content = content
        self.frontmatter = frontmatter
        self.action = action
        self.new_path = new_path


def notes_root(notes_dir: str | Path | None = None) -> Path:
    if notes_dir is None:
        import spaces  # noqa: PLC0415  -- spaces imports this module

        notes_dir = spaces.content_dir(spaces.DEFAULT_SPACE_ID)
    return Path(notes_dir).resolve()


def resolve_note_path(filepath: str | Path, notes_dir: str | Path | None = None) -> Path:
    """Resolve `filepath` against NOTES_DIR, refusing anything that escapes it."""
    root = notes_root(notes_dir)
    path = (root / filepath).resolve()
    if not path.is_relative_to(root) or path == root:
        raise NotePathError(f"{filepath} is outside the notes directory")
    if path.suffix.lower() != NOTE_SUFFIX:
        raise NotePathError(f"{filepath} is not a {NOTE_SUFFIX} file")
    return path


def resolve_folder_path(folderpath: str | Path, notes_dir: str | Path | None = None) -> Path:
    """Resolve a folder `folderpath` against NOTES_DIR, refusing NOTES_DIR itself and anything outside it."""
    root = notes_root(notes_dir)
    path = (root / folderpath).resolve()
    if not path.is_relative_to(root) or path == root:
        raise NotePathError(f"{folderpath} is outside the notes directory")
    return path


def parse_note(text: str) -> tuple[dict[str, Any], str]:
    """Split note text into (front-matter, content). The content is returned verbatim."""
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise FrontMatterError(f"Invalid YAML front-matter: {exc}") from exc
    if frontmatter is None:
        frontmatter = {}
    if not isinstance(frontmatter, dict):
        raise FrontMatterError("Front-matter must be a mapping")
    return frontmatter, text[match.end():]


def serialize_note(content: str, frontmatter: dict[str, Any]) -> str:
    """Inverse of `parse_note`: `parse_note(serialize_note(c, fm)) == (fm, c)`."""
    if not isinstance(content, str):
        raise TypeError("content must be a string")
    if not isinstance(frontmatter, dict):
        raise FrontMatterError("Front-matter must be a mapping")
    if not frontmatter:
        # Content that itself starts like a front-matter block needs an empty block
        # in front of it, or it would be read back as front-matter.
        return f"---\n---\n{content}" if _FRONTMATTER_RE.match(content) else content
    try:
        block = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True, default_flow_style=False)
    except yaml.YAMLError as exc:
        raise FrontMatterError(f"Front-matter cannot be written as YAML: {exc}") from exc
    return f"---\n{block}---\n{content}"


def _relative(path: Path, notes_dir: str | Path | None) -> str:
    return path.relative_to(notes_root(notes_dir)).as_posix()


def _history_id(path: Path, notes_dir: str | Path | None) -> str:
    """History entity id of a note, unique across spaces.

    Notes in the Default space's content/ keep their bare relative path, so history from
    before Spaces still lines up.
    """
    import spaces  # noqa: PLC0415  -- spaces imports this module

    default, root = spaces.content_dir(spaces.DEFAULT_SPACE_ID).resolve(), spaces.spaces_root()
    if path.is_relative_to(default):
        return path.relative_to(default).as_posix()
    if path.is_relative_to(root):
        return f"spaces/{path.relative_to(root).as_posix()}"
    return _relative(path, notes_dir)


def _check_access(
    mode: AccessMode, approved: bool, path: Path, verb: str, approval: Callable[[], ApprovalRequiredError]
) -> None:
    """Raise unless `mode` allows the change; `approval` builds the ApprovalRequiredError."""
    if mode is AccessMode.READ_ONLY:
        raise AccessDeniedError(f"Notes are read only; refusing to {verb} {path}")
    if mode is AccessMode.ASK_FIRST and not approved:
        raise approval()


def _note_state(path: Path, notes_dir: str | Path | None) -> dict[str, Any]:
    """Snapshot of the note on disk. Unparseable front-matter is kept as raw content."""
    with path.open(encoding="utf-8-sig", newline="") as fh:
        text = fh.read()
    try:
        frontmatter, content = parse_note(text)
    except FrontMatterError:
        frontmatter, content = {}, text
    return {"path": _relative(path, notes_dir), "frontmatter": frontmatter, "content": content}


@functools.cache
def _ensure_history_table(bind: Engine) -> None:
    database.init_db(bind)


@contextmanager
def _recorded_all(changes: list[tuple[str, str, dict[str, Any]]], source: str) -> Iterator[None]:
    """Record note changes `(entity id, action, state)` in `history`, committed only if the
    file operation succeeds."""
    with database.SessionLocal() as session:
        _ensure_history_table(session.get_bind())
        with session.begin():
            for entity_id, action, state in changes:
                history.record(session, "Note", entity_id, action, state, source)
            session.flush()
            yield


def _recorded(entity_id: str, action: str, state: dict[str, Any], source: str):
    """Record one note change in `history`; it is committed only if the file operation succeeds."""
    return _recorded_all([(entity_id, action, state)], source)


def read_note(filepath: str | Path, *, notes_dir: str | Path | None = None) -> dict[str, Any]:
    """Read a note. Returns `{"path", "frontmatter", "content"}` with `path` relative to NOTES_DIR."""
    path = resolve_note_path(filepath, notes_dir)
    # newline="" keeps CRLF line endings intact; utf-8-sig drops a leading BOM.
    with path.open(encoding="utf-8-sig", newline="") as fh:
        text = fh.read()
    frontmatter, content = parse_note(text)
    return {
        "path": _relative(path, notes_dir),
        "frontmatter": frontmatter,
        "content": content,
    }


def note_hash(filepath: str | Path, *, notes_dir: str | Path | None = None) -> str | None:
    """SHA-256 of the note file's bytes, or None if it does not exist (to detect concurrent edits)."""
    path = resolve_note_path(filepath, notes_dir)
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def list_notes(pattern: str, *, notes_dir: str | Path | None = None) -> list[str]:
    """Paths (relative to NOTES_DIR, sorted) of the notes matching a glob such as `*/Notes-in/*.md`."""
    root = notes_root(notes_dir)
    return sorted(
        _relative(path, notes_dir)
        for path in root.glob(pattern)
        if path.is_file() and path.suffix.lower() == NOTE_SUFFIX
    )


def write_note(
    filepath: str | Path,
    content: str,
    frontmatter: dict[str, Any],
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> bool:
    """Write a note if `access_mode` allows it, recording the change as made by `source`.

    Returns True if the file was written, False if it already had exactly this text.
    Raises `AccessDeniedError` / `ApprovalRequiredError` when the mode forbids the write.
    """
    mode = AccessMode(access_mode)  # ValueError for unknown modes
    path = resolve_note_path(filepath, notes_dir)
    _check_access(mode, approved, path, "write", lambda: ApprovalRequiredError(path, content, frontmatter))

    data = serialize_note(content, frontmatter).encode("utf-8")
    exists = path.is_file()
    if exists and path.read_bytes() == data:
        return False

    rel = _relative(path, notes_dir)
    state = {"path": rel, "frontmatter": frontmatter, "content": content}
    with _recorded(_history_id(path, notes_dir), "update" if exists else "create", state, source):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file and swap it in, so a crash never leaves a half-written note.
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise
    return True


def rename_note(
    filepath: str | Path,
    new_filepath: str | Path,
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> None:
    """Move a note within NOTES_DIR, recording a "rename" under the new path.

    The snapshot's `previous_path` links the note's history across the rename.
    Raises `FileNotFoundError` / `FileExistsError` for a missing note or a taken destination.
    """
    mode = AccessMode(access_mode)
    path = resolve_note_path(filepath, notes_dir)
    new_path = resolve_note_path(new_filepath, notes_dir)
    state = _note_state(path, notes_dir)
    _check_access(
        mode,
        approved,
        path,
        "rename",
        lambda: ApprovalRequiredError(
            path, state["content"], state["frontmatter"], action="rename", new_path=new_path
        ),
    )
    if new_path.exists():
        raise FileExistsError(f"{new_filepath} already exists")

    rel = _relative(new_path, notes_dir)
    state = {**state, "path": rel, "previous_path": state["path"]}
    with _recorded(_history_id(new_path, notes_dir), "rename", state, source):
        new_path.parent.mkdir(parents=True, exist_ok=True)
        path.rename(new_path)


def delete_note(
    filepath: str | Path,
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> None:
    """Delete a note file. Its last state is kept in `history`, so it can be restored."""
    mode = AccessMode(access_mode)
    path = resolve_note_path(filepath, notes_dir)
    state = _note_state(path, notes_dir)
    _check_access(
        mode,
        approved,
        path,
        "delete",
        lambda: ApprovalRequiredError(path, state["content"], state["frontmatter"], action="delete"),
    )
    with _recorded(_history_id(path, notes_dir), "delete", state, source):
        path.unlink()


def copy_note(
    filepath: str | Path,
    new_filepath: str | Path,
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> None:
    """Copy a note byte for byte, recording a "create" whose snapshot's `copied_from` names the original.

    Raises `FileNotFoundError` / `FileExistsError` for a missing note or a taken destination.
    """
    mode = AccessMode(access_mode)
    path = resolve_note_path(filepath, notes_dir)
    new_path = resolve_note_path(new_filepath, notes_dir)
    state = _note_state(path, notes_dir)
    _check_access(
        mode,
        approved,
        new_path,
        "write",
        lambda: ApprovalRequiredError(new_path, state["content"], state["frontmatter"]),
    )
    if new_path.exists():
        raise FileExistsError(f"{new_filepath} already exists")

    state = {**state, "path": _relative(new_path, notes_dir), "copied_from": state["path"]}
    with _recorded(_history_id(new_path, notes_dir), "create", state, source):
        new_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, new_path)


# --- Folders --------------------------------------------------------------------


def _folder_notes(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() == NOTE_SUFFIX)


def _folder_pair(folderpath: str | Path, new_folderpath: str | Path, notes_dir: str | Path | None) -> tuple[Path, Path]:
    """The source and destination of a folder move or copy, checked."""
    path = resolve_folder_path(folderpath, notes_dir)
    new_path = resolve_folder_path(new_folderpath, notes_dir)
    if not path.is_dir():
        raise FileNotFoundError(f"No folder at {folderpath}")
    if new_path.is_relative_to(path):
        raise NotePathError(f"{new_folderpath} is inside {folderpath}")
    if new_path.exists():
        raise FileExistsError(f"{new_folderpath} already exists")
    return path, new_path


def move_folder(
    folderpath: str | Path,
    new_folderpath: str | Path,
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> None:
    """Move (or rename) a folder within NOTES_DIR, recording a "rename" for every note in it.

    Raises `FileNotFoundError` / `FileExistsError` for a missing folder or a taken destination,
    and `NotePathError` for a move into the folder itself.
    """
    mode = AccessMode(access_mode)
    path, new_path = _folder_pair(folderpath, new_folderpath, notes_dir)
    _check_access(
        mode, approved, path, "move", lambda: ApprovalRequiredError(path, "", {}, action="rename", new_path=new_path)
    )
    changes = []
    for note in _folder_notes(path):
        target = new_path / note.relative_to(path)
        state = _note_state(note, notes_dir)
        state = {**state, "path": _relative(target, notes_dir), "previous_path": state["path"]}
        changes.append((_history_id(target, notes_dir), "rename", state))
    with _recorded_all(changes, source):
        new_path.parent.mkdir(parents=True, exist_ok=True)
        path.rename(new_path)


def copy_folder(
    folderpath: str | Path,
    new_folderpath: str | Path,
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> None:
    """Copy a folder with everything in it, recording a "create" for every note in the copy."""
    mode = AccessMode(access_mode)
    path, new_path = _folder_pair(folderpath, new_folderpath, notes_dir)
    _check_access(mode, approved, new_path, "write", lambda: ApprovalRequiredError(new_path, "", {}))
    changes = []
    for note in _folder_notes(path):
        target = new_path / note.relative_to(path)
        state = _note_state(note, notes_dir)
        state = {**state, "path": _relative(target, notes_dir), "copied_from": state["path"]}
        changes.append((_history_id(target, notes_dir), "create", state))
    with _recorded_all(changes, source):
        shutil.copytree(path, new_path)


def delete_folder(
    folderpath: str | Path,
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
    source: str = history.DEFAULT_SOURCE,
) -> None:
    """Delete a folder with everything in it. The last state of every note in it is kept in `history`."""
    mode = AccessMode(access_mode)
    path = resolve_folder_path(folderpath, notes_dir)
    if not path.is_dir():
        raise FileNotFoundError(f"No folder at {folderpath}")
    _check_access(mode, approved, path, "delete", lambda: ApprovalRequiredError(path, "", {}, action="delete"))
    changes = [
        (_history_id(note, notes_dir), "delete", _note_state(note, notes_dir)) for note in _folder_notes(path)
    ]
    with _recorded_all(changes, source):
        shutil.rmtree(path)


# --- Assets (pasted images and attached files) ------------------------------------

ASSETS_DIR = ".assets"
# The image types the editor may paste, by MIME type, with the suffix they're stored under. Other files keep the
# suffix of their own name.
IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
# Stored names are `<uuid hex><suffix>`, so a name from a URL can't point anywhere else.
_ASSET_NAME_RE = re.compile(r"\A[0-9a-f]{32}\.[a-zA-Z0-9]{1,10}\Z")
_ASSET_SUFFIX_RE = re.compile(r"\A\.[a-zA-Z0-9]{1,10}\Z")


def save_asset(
    data: bytes, content_type: str, filename: str | None = None, *, notes_dir: str | Path | None = None
) -> str:
    """Store a file under NOTES_DIR/.assets/ with a fresh name, returning that name.

    An image in `IMAGE_SUFFIXES` is stored under its type's suffix; any other file under the suffix of `filename`, or
    `.bin` if it has none (or an odd one). Assets aren't notes: no history is kept.
    """
    suffix = IMAGE_SUFFIXES.get(content_type)
    if suffix is None:
        suffix = Path(filename or "").suffix.lower()
        if not _ASSET_SUFFIX_RE.match(suffix):
            suffix = ".bin"
    folder = notes_root(notes_dir) / ASSETS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex + suffix
    (folder / name).write_bytes(data)
    return name


def asset_path(name: str, *, notes_dir: str | Path | None = None) -> Path:
    """The file of a stored asset. Raises `NotePathError` for a malformed name, `FileNotFoundError` if it's missing."""
    if not _ASSET_NAME_RE.match(name):
        raise NotePathError(f"{name} is not an asset name")
    path = notes_root(notes_dir) / ASSETS_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"No asset {name}")
    return path
