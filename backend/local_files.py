"""Files on the machine running the backend, outside any space: linked from notes and read by the agent.

Notes may link to local files and folders (`file:///C:/Projects/C7801/Lines.pdf`, `C:\\Projects\\C7801`,
`\\\\server\\share\\...`, `/home/...`). On the machine itself the app opens them with the system's default
program (`open_path`); a remote client gets a Windows shortcut to the same file on the network share instead
(`generate_shortcut_content`, with the share's UNC path from `to_unc_path`), so nothing large crosses HTTP.

The agent crawls the same file system with `search_local_files`, `list_local_directory` and `read_local_file` to find
design data.
"""

import fnmatch
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

TEXT_SUFFIXES = {".txt", ".md", ".csv", ".json", ".tsv", ".log", ".xml", ".yaml", ".yml", ".ini"}
READ_LIMIT = 20_000  # characters of a file's text returned to the agent
LIST_LIMIT = 500  # entries of a directory listed for the agent
STAT_LIMIT = 1_000  # files counted towards a folder's size, so a huge network share can't hang the request
SEARCH_SCAN_LIMIT = 10_000  # files and folders looked at by one search, so a huge network share can't hang the agent
SEARCH_MATCH_LIMIT = 100  # matches returned by one search
_SKIPPED_NAMES = {"__pycache__", "node_modules", "$recycle.bin", "system volume information"}

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
        return {
            "exists": True,
            "name": path.name or str(path),
            "type": "directory" if is_dir else "file",
            "path": str(path),
            "unc_path": to_unc_path(raw),
        }
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
    entry = {**_entry(path), "partial": False, "unc_path": to_unc_path(raw)}
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


_ERROR_MORE_DATA = 234
_ERROR_CONNECTION_UNAVAIL = 1201  # a persistent mapping that isn't connected right now; its share is still known


def _mapped_share(drive: str) -> str | None:
    r"""The network share a Windows drive letter (`O:`) is mapped to, like `\server\share\folder`, or None."""
    import ctypes
    from ctypes import wintypes

    try:
        size = wintypes.DWORD(1024)
        while True:
            buffer = ctypes.create_unicode_buffer(size.value)
            result = ctypes.windll.mpr.WNetGetConnectionW(drive, buffer, ctypes.byref(size))  # type: ignore[attr-defined]
            if result != _ERROR_MORE_DATA:
                break
    except (AttributeError, OSError):
        return None
    if result not in (0, _ERROR_CONNECTION_UNAVAIL):
        return None
    return buffer.value or None


def to_unc_path(raw: str) -> str:
    r"""A link's path as other machines on the network reach it: on Windows a mapped drive's path becomes the share's
    UNC path (`O:\Lawrences Files` -> `\syfileapp1\Archive Data\Older Yachts\Lawrences Files`); any other path
    is returned as it is."""
    path = to_path(raw)
    text = str(path)
    if sys.platform != "win32":
        return text
    if text.startswith(("\\\\", "//")):
        return text.replace("/", "\\")
    if path.drive:
        share = _mapped_share(path.drive)
        if share:
            return share.rstrip("\\") + text[len(path.drive) :]
    return text


def _file_url(path: str) -> str:
    """A `file:` URL for a UNC or local path (`file://server/share/a%20b`, `file:///C:/x`, `file:///home/x`),
    percent-encoded so the shortcut is plain ASCII whatever the code page."""
    text = path.replace("\\", "/")
    if not text.startswith("/"):
        text = f"/{text}"  # a drive path, C:/x
    return "file:" + ("" if text.startswith("//") else "//") + quote(text, safe="/:")


def generate_shortcut_content(raw: str) -> tuple[str, str, str]:
    """A Windows Internet Shortcut (`.url`) to a file or folder on the network share: `(content, file name, UNC path)`.
    Opening it on a client launches the file, or the folder in Windows Explorer, straight from the share."""
    path = _existing(raw)
    unc_path = to_unc_path(raw)
    content = f"[InternetShortcut]\r\nURL={_file_url(unc_path)}\r\n"
    return content, f"{path.name or 'Network-Shortcut'}.url", unc_path


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


def _skipped(name: str) -> bool:
    """Hidden and system entries (`.git`, `$RECYCLE.BIN`, `__pycache__`, ...) a search doesn't look into."""
    return name.startswith((".", "$", "~$")) or name.lower() in _SKIPPED_NAMES


def _matcher(query: str) -> Callable[[str], bool]:
    """A case-insensitive test of a name: a glob (`*.xlsx`, `lines*.pdf`) when the query has wildcards, else every
    word of the query must be in the name (`lines plan` matches `C7801 Lines Plan rev B.pdf`)."""
    text = query.strip().lower()
    if not text:
        raise LocalFileError("Give a name or keyword to search for")
    if any(c in text for c in "*?["):
        return lambda name: fnmatch.fnmatchcase(name.lower(), text)
    terms = text.split()
    return lambda name: all(term in name.lower() for term in terms)


def search_local_files(path: str, query: str) -> dict[str, Any]:
    """The files and folders under a local folder, at any depth, whose names match `query`:
    `{path, query, count, matches: [{name, path, type, size}], truncated}`. It stops after looking at
    `SEARCH_SCAN_LIMIT` entries or finding `SEARCH_MATCH_LIMIT` matches (`truncated`), and skips hidden folders."""
    folder = _existing(path)
    if not folder.is_dir():
        raise LocalFileError(f"Not a folder: {folder}; use read_local_file to read a file")
    matches = _matcher(query)
    found: list[dict[str, Any]] = []
    scanned, truncated, pending = 0, False, [folder]
    while pending and not truncated:
        try:
            with os.scandir(pending.pop(0)) as entries:
                children = sorted(entries, key=lambda e: e.name.lower())
        except OSError:
            continue  # A folder we may not read is left out.
        for entry in children:
            if _skipped(entry.name):
                continue
            if scanned >= SEARCH_SCAN_LIMIT or len(found) >= SEARCH_MATCH_LIMIT:
                truncated = True
                break
            scanned += 1
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
                if is_dir:
                    pending.append(Path(entry.path))
                if matches(entry.name):
                    size = 0 if is_dir else entry.stat().st_size
                    found.append({"name": entry.name, "path": entry.path, "type": "directory" if is_dir else "file", "size": size})
            except OSError:
                continue  # Broken links and files we may not stat are left out.
    return {"path": str(folder), "query": query, "count": len(found), "matches": found, "truncated": truncated}


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
