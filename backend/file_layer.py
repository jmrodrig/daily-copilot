"""Markdown file layer: read and write notes with YAML front-matter under NOTES_DIR.

The agent access mode is enforced here, server-side, so no caller can bypass it:

- `read_only`: writes are refused with `AccessDeniedError`.
- `ask_first`: writes raise `ApprovalRequiredError` (carrying the proposed change)
  unless the caller passes `approved=True` after the user has confirmed.
- `write_directly`: writes go straight to disk.
"""

import os
import re
import tempfile
from pathlib import Path
from typing import Any

import yaml

from config import get_settings
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
    """Write attempted in `ask_first` mode without user approval."""

    def __init__(self, path: Path, content: str, frontmatter: dict[str, Any]):
        super().__init__(f"Writing {path} requires user approval")
        self.path = path
        self.content = content
        self.frontmatter = frontmatter


def notes_root(notes_dir: str | Path | None = None) -> Path:
    return Path(notes_dir if notes_dir is not None else get_settings().notes_dir).resolve()


def resolve_note_path(filepath: str | Path, notes_dir: str | Path | None = None) -> Path:
    """Resolve `filepath` against NOTES_DIR, refusing anything that escapes it."""
    root = notes_root(notes_dir)
    path = (root / filepath).resolve()
    if not path.is_relative_to(root) or path == root:
        raise NotePathError(f"{filepath} is outside the notes directory")
    if path.suffix.lower() != NOTE_SUFFIX:
        raise NotePathError(f"{filepath} is not a {NOTE_SUFFIX} file")
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


def read_note(filepath: str | Path, *, notes_dir: str | Path | None = None) -> dict[str, Any]:
    """Read a note. Returns `{"path", "frontmatter", "content"}` with `path` relative to NOTES_DIR."""
    path = resolve_note_path(filepath, notes_dir)
    # newline="" keeps CRLF line endings intact; utf-8-sig drops a leading BOM.
    with path.open(encoding="utf-8-sig", newline="") as fh:
        text = fh.read()
    frontmatter, content = parse_note(text)
    return {
        "path": path.relative_to(notes_root(notes_dir)).as_posix(),
        "frontmatter": frontmatter,
        "content": content,
    }


def write_note(
    filepath: str | Path,
    content: str,
    frontmatter: dict[str, Any],
    access_mode: AccessMode | str,
    *,
    approved: bool = False,
    notes_dir: str | Path | None = None,
) -> bool:
    """Write a note if `access_mode` allows it.

    Returns True if the file was written, False if it already had exactly this text.
    Raises `AccessDeniedError` / `ApprovalRequiredError` when the mode forbids the write.
    """
    mode = AccessMode(access_mode)  # ValueError for unknown modes
    path = resolve_note_path(filepath, notes_dir)

    if mode is AccessMode.READ_ONLY:
        raise AccessDeniedError(f"Notes are read only; refusing to write {path}")
    if mode is AccessMode.ASK_FIRST and not approved:
        raise ApprovalRequiredError(path, content, frontmatter)

    data = serialize_note(content, frontmatter).encode("utf-8")
    if path.is_file() and path.read_bytes() == data:
        return False

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
