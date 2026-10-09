"""Files on the machine running the backend, outside any space: linked from notes and read by the agent.

Notes may link to local files and folders (`file:///C:/Projects/C7801/Lines.pdf`, `C:\\Projects\\C7801`,
`\\\\server\\share\\...`, `/home/...`). On the machine itself the app opens them with the system's default
program (`open_path`); a remote client downloads them instead (`stat_path`, a file, or `zip_directory`).

The agent crawls the same file system with `list_local_directory` and `read_local_file` to find design data.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

TEXT_SUFFIXES = {".txt", ".md", ".csv", ".json", ".tsv", ".log", ".xml", ".yaml", ".yml", ".ini"}
READ_LIMIT = 20_000  # characters of a file's text returned to the agent
LIST_LIMIT = 500  # entries of a directory listed for the agent
STAT_LIMIT = 1_000  # files counted towards a folder's size, so a huge network share can't hang the request

_WINDOWS_DRIVE = re.compile(r"^/?[A-Za-z]:[\\/]")


class LocalFileError(Exception):
    """A path that can't be used: not absolute, or the wrong kind of entry."""


def to_path(raw: str) -> Path:
    """An absolute local path from a link: a `file://` URL, a Windows drive or UNC path, or a POSIX path."""
    text = raw.strip().strip('"')
    if text.lower().startswith("file:"):
        url = urlparse(text)
        # file://server/share/x is a UNC path; file:///C:/x and file:///home/x are local.
        text = unquote(url.path)
        if url.netloc and url.netloc.lower() != "localhost":
            text = f"//{url.netloc}{text}"
        if _WINDOWS_DRIVE.match(text):
            text = text.lstrip("/")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise LocalFileError(f"Not an absolute path: {raw}")
    return path


def _existing(raw: str) -> Path:
    path = to_path(raw)
    if not path.exists():
        raise FileNotFoundError(f"No file or folder at {path}")
    return path


def _entry(path: Path) -> dict[str, Any]:
    is_dir = path.is_dir()
    return {"name": path.name or str(path), "type": "directory" if is_dir else "file", "size": 0 if is_dir else path.stat().st_size}


def check_path(raw: str) -> dict[str, Any]:
    """Whether a linked path exists: `{exists, name, type, path}`, with an `error` when it doesn't.

    Only the path itself is looked at, never what's in a folder, so it answers at once even for a huge network drive.
    """
    try:
        path = to_path(raw)
        if not path.exists():
            return {"exists": False, "name": path.name or str(path), "type": "unknown", "path": str(path), "error": f"No file or folder at {path}"}
        is_dir = path.is_dir()
        return {"exists": True, "name": path.name or str(path), "type": "directory" if is_dir else "file", "path": str(path)}
    except (LocalFileError, OSError) as exc:
        return {"exists": False, "path": raw, "error": str(exc)}


def _folder_size(folder: Path) -> tuple[int, bool]:
    """The total size of the files in a folder and whether it's complete: it stops after `STAT_LIMIT` files, and
    skips subfolders and files it can't read."""
    total, counted, pending = 0, 0, [folder]
    while pending:
        try:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                        elif entry.is_file():
                            if counted >= STAT_LIMIT:
                                return total, False
                            total += entry.stat().st_size
                            counted += 1
                    except OSError:
                        continue
        except OSError:
            continue
    return total, True


def stat_path(raw: str) -> dict[str, Any]:
    """`{name, type, size, partial}` of a file or folder; a folder's size is the total of the files in it, `partial`
    when only the first `STAT_LIMIT` files were counted."""
    path = _existing(raw)
    entry = {**_entry(path), "partial": False}
    if path.is_dir():
        size, complete = _folder_size(path)
        entry["size"], entry["partial"] = size, not complete
    return entry


def open_path(raw: str) -> None:
    """Open a file or folder with the system's default program."""
    path = _existing(raw)
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]  # Windows only
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])


def file_path(raw: str) -> Path:
    """A file to download."""
    path = _existing(raw)
    if not path.is_file():
        raise LocalFileError(f"Not a file: {path}")
    return path


def zip_directory(raw: str) -> tuple[Path, str]:
    """A temporary ZIP of a folder and the name to download it as; the caller deletes the ZIP's folder when sent."""
    path = _existing(raw)
    if not path.is_dir():
        raise LocalFileError(f"Not a folder: {path}")
    name = path.name or "folder"
    archive = Path(tempfile.mkdtemp(prefix="copilot-zip-")) / f"{name}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in path.rglob("*"):
            if file.is_file():
                try:
                    zf.write(file, Path(name) / file.relative_to(path))
                except OSError:
                    continue  # A locked or vanished file must not break the whole download.
    return archive, f"{name}.zip"


def remove_temp(archive: Path) -> None:
    shutil.rmtree(archive.parent, ignore_errors=True)


# --- Agent tools ---------------------------------------------------------------


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds")


def list_local_directory(path: str) -> dict[str, Any]:
    """The files and subfolders of a local folder: `{path, count, entries: [{name, type, size}]}`."""
    folder = _existing(path)
    if not folder.is_dir():
        raise LocalFileError(f"Not a folder: {folder}; use read_local_file to read a file")
    entries = []
    for child in sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        try:
            entries.append(_entry(child))
        except OSError:
            continue  # Broken links and files we may not stat are left out.
    result: dict[str, Any] = {"path": str(folder), "count": len(entries), "entries": entries[:LIST_LIMIT]}
    if len(entries) > LIST_LIMIT:
        result["truncated"] = f"Only the first {LIST_LIMIT} entries are listed"
    return result


def _truncate(text: str) -> str:
    if len(text) <= READ_LIMIT:
        return text
    return text[:READ_LIMIT] + f"\n\n[… truncated, {len(text)} characters in total]"


def read_local_file(path: str) -> dict[str, Any]:
    """A local file's text: plain text files as they are, PDFs' extracted text, and for other formats
    (Word, Excel, CAD, Maxsurf, ...) only their metadata."""
    file = _existing(path)
    if file.is_dir():
        raise LocalFileError(f"{file} is a folder; use list_local_directory to list it")
    stat = file.stat()
    meta = {"path": str(file), "size": stat.st_size, "created": _iso(stat.st_ctime), "modified": _iso(stat.st_mtime)}
    suffix = file.suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return {**meta, "content": _truncate(file.read_text(encoding="utf-8", errors="replace"))}
    if suffix == ".pdf":
        import pymupdf

        try:
            with pymupdf.open(file) as doc:
                pages = [f"--- Page {i} ---\n{page.get_text()}" for i, page in enumerate(doc, start=1)]
        except Exception as exc:  # pymupdf raises its own types for damaged or encrypted files
            raise LocalFileError(f"Could not read the PDF {file}: {exc}") from exc
        return {**meta, "pages": len(pages), "content": _truncate("\n".join(pages))}
    return {**meta, "message": f"Text extraction for {suffix or 'files without an extension'} is not supported yet; only the metadata is available."}
