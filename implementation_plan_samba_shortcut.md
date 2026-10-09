# Implementation Plan: Option A - Samba Network Shortcut Launcher

## Branch
Continue on branch `feat/local-files`.

## Objective
Replace the remote client download behavior with Option A:
When a user on a remote client clicks a local file or folder link, instead of downloading large files or ZIP archives over HTTP, generate and trigger a Windows Internet Shortcut (`.url`) pointing to the resolved Samba/UNC network share (`\\syfileapp1\...`). Opening this shortcut natively launches the file or directory in Windows Explorer over the local network share.

---

## 1. Backend Implementation

### A. UNC Path Resolution (`backend/local_files.py`)
1. Implement `to_unc_path(raw: str) -> str`:
   - Resolve `raw` to an absolute path using `to_path(raw)`.
   - On Windows (`sys.platform == "win32"`):
     - If `path.drive` exists (e.g., `O:`, `Y:`):
       - Use `ctypes.windll.mpr.WNetGetConnectionW(path.drive, ...)` to query the remote network share name.
       - If it successfully returns a UNC prefix (e.g., `\\syfileapp1\Archive Data\Older Yachts`):
         - Extract the subpath after the drive letter (e.g., `\Lawrences Files`).
         - Combine them into the canonical UNC path: `\\syfileapp1\Archive Data\Older Yachts\Lawrences Files`.
     - If the path is already a UNC path (starts with `\\` or `//`), normalize backslashes.
   - If not a mapped drive or on non-Windows platforms, fallback to `str(path)`.
2. Implement `generate_shortcut_content(raw: str) -> tuple[str, str, str]`:
   - Returns `(shortcut_ini_text, file_name, unc_path)`:
     ```ini
     [InternetShortcut]
     URL=file:{unc_path_formatted}
     ```
     where `unc_path_formatted` is either `\\\\server\\share\\path` or formatted with forward slashes `file://///server/share/path` so Windows Explorer opens it directly.
   - File name is `{path.name or 'Network-Shortcut'}.url`.
3. In `stat_path(raw: str)`:
   - Add `"unc_path": to_unc_path(raw)` to the dictionary returned by `stat_path`.

### B. Schemas (`backend/schemas.py`)
1. In `LocalFileStat`, add optional field:
   ```python
   unc_path: str | None = None
   ```
2. In `LocalFileCheck`, add optional field:
   ```python
   unc_path: str | None = None
   ```

### C. New Endpoint (`backend/main.py`)
Add endpoint `GET /api/local-files/shortcut`:
```python
@app.get("/api/local-files/shortcut")
def get_local_file_shortcut(path: str) -> Response:
    """Generate a .url Windows Internet Shortcut for a local/network file or folder."""
    try:
        content, filename, _ = local_files.generate_shortcut_content(path)
    except (local_files.LocalFileError, OSError) as exc:
        raise _local_file_errors(exc) from exc
    return Response(
        content=content.encode("utf-8"),
        media_type="application/x-mswinurl",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
```

### D. Unit Tests (`backend/tests/test_local_files.py`)
1. Test `to_unc_path` with mapped drives (mocking `WNetGetConnectionW`) and UNC paths.
2. Test `GET /api/local-files/shortcut` returns valid `.url` INI content and correct headers.

---

## 2. Frontend Implementation

### A. `desktop/src/lib/localFiles.ts`
1. Update `LocalFileStat` type to include `unc_path?: string`.
2. Update `openLocalFile(href: string)`:
   - **On localhost:** Keep `POST /api/local-files/open` (launches locally via host `os.startfile`).
   - **On remote client:**
     - Fetch `stat` via `/api/local-files/stat?path=${encodeURIComponent(href)}`.
     - Automatically copy `stat.unc_path || href` to the user's clipboard (`navigator.clipboard.writeText`) as a seamless fallback.
     - Download the `.url` shortcut via `/api/local-files/shortcut?path=${encodeURIComponent(href)}`.
     - Display a brief, helpful prompt / toast / alert informing the user:
       `Opening via network drive... (Shortcut downloaded. Network path also copied to clipboard: ${unc_path})`
     - **Remove** the heavy file/ZIP download prompt (`download` and `download-zip` are no longer triggered on click).

---

## 3. Verification
1. Run backend tests: `pytest backend/tests/`
2. Run frontend typecheck: `npm run typecheck`
3. Verify `GET /api/local-files/shortcut?path=O:\Lawrences Files` returns a valid `.url` file pointing to `\\syfileapp1\Archive Data\Older Yachts\Lawrences Files`.
