# Implementation Plan: Check if Local Link Exists on Server

## Branch
Continue on branch `feat/local-files`.

## Objective
Add a fast, robust check to determine if a local link (path or `file://` URI) exists on the server's file system:
1. Validate paths in real time when typing/inserting in the link panel UI.
2. Provide immediate visual feedback (success badge or error warning) and prevent inserting broken local paths.
3. Fix `referencePill` double-click handling so local file pills open via `openLocalFile`.
4. Prevent server hangs on huge network drives (`O:\`, `Y:\`) during file checks.

---

## 1. Backend Changes

### A. `backend/local_files.py`
1. Add `check_path(raw: str) -> dict[str, Any]`:
   - Resolve `raw` using `to_path(raw)`.
   - Check `path.exists()`.
   - If it exists:
     ```python
     is_dir = path.is_dir()
     return {
         "exists": True,
         "name": path.name or str(path),
         "type": "directory" if is_dir else "file",
         "path": str(path),
     }
     ```
   - If it does not exist:
     ```python
     return {
         "exists": False,
         "name": path.name or str(path),
         "type": "unknown",
         "path": str(path),
         "error": f"No file or folder at {path}",
     }
     ```
   - Catch `(LocalFileError, OSError)` gracefully and return `{"exists": False, "path": raw, "error": str(exc)}`.
   - **CRITICAL:** Do NOT call `rglob("*")` during this check; it must return in milliseconds even for massive network shares (`O:\`, `Y:\`).
2. Guard `stat_path(raw: str)`:
   - For directories, avoid unbounded `rglob("*")` that freezes on multi-gigabyte network drives. Limit directory size traversal (e.g., max 1,000 files scanned or immediate children only) or catch OS timeout/errors gracefully.

### B. `backend/schemas.py`
Add model:
```python
class LocalFileCheck(BaseModel):
    exists: bool
    name: str | None = None
    type: str | None = None
    path: str
    error: str | None = None
```

### C. `backend/main.py`
Add endpoint:
```python
@app.get("/api/local-files/check")
def check_local_file(path: str) -> schemas.LocalFileCheck:
    """Check whether a path or file:// URL exists on the server's file system."""
    return schemas.LocalFileCheck(**local_files.check_path(path))
```

### D. `backend/tests/test_local_files.py`
Add tests for `check_path` and `GET /api/local-files/check`:
- Existing directory returns `exists=True` and `type="directory"`.
- Existing file returns `exists=True` and `type="file"`.
- Non-existent path returns `exists=False`.

---

## 2. Frontend Changes

### A. `desktop/src/lib/localFiles.ts`
1. Define type `LocalFileCheck`:
   ```ts
   export type LocalFileCheck = {
     exists: boolean;
     name?: string;
     type?: "file" | "directory" | "unknown";
     path: string;
     error?: string;
   };
   ```
2. Add helper function:
   ```ts
   export async function checkLocalFile(href: string): Promise<LocalFileCheck> {
     try {
       return await getJson<LocalFileCheck>(`/api/local-files/check?path=${encodeURIComponent(href)}`);
     } catch (err) {
       return { exists: false, path: href, error: message(err) };
     }
   }
   ```

### B. `desktop/src/components/refPanels.tsx` (`LinkPanel`)
1. In `LinkPanel`, add state for checking local file existence:
   ```ts
   const [localCheck, setLocalCheck] = useState<{ loading: boolean; result: LocalFileCheck | null }>({ loading: false, result: null });
   ```
2. When `url` changes and `isLocalHref(url)` is true:
   - Run a debounced check (150-250ms) calling `checkLocalFile(url)`.
   - Set `localCheck.result`.
   - If not a local URL, reset `localCheck` to `{ loading: false, result: null }`.
3. In the UI preview section (where `url` is shown):
   - If `isLocalHref(url)`:
     - If `localCheck.loading`: Show "Checking server file system..." with a subtle spinner/muted text.
     - If `localCheck.result?.exists`: Show a green checkmark or badge:
       `✓ Exists on server (${localCheck.result.type}: ${localCheck.result.name})`.
       Also default `displayText` to `localCheck.result.name` if `displayText` is empty or matches the raw path.
     - If `localCheck.result?.exists === false`: Show a red warning message:
       `⚠ Not found on server file system (${localCheck.result.error || "File or folder does not exist"})`.
4. In the "Insert" button:
   - Disable if `isLocalHref(url)` and `localCheck.loading`.
   - Disable if `isLocalHref(url)` and `localCheck.result && !localCheck.result.exists`.

### C. `desktop/src/components/referencePill.tsx`
1. In `PillView`:
   - In `open()`:
     ```ts
     function open() {
       if (taskId !== null) openTask(taskId);
       else if (kind === "url") {
         if (isLocalHref(href)) void openLocalFile(href);
         else window.open(href, "_blank", "noopener,noreferrer");
       } else navigate(href);
     }
     ```
   - In `PillIcon`:
     - If `kind === "url"` and `isLocalHref(href)`: show the folder icon instead of the generic globe icon.

---

## 3. Verification & Testing Gate
1. Run backend tests: `pytest backend/tests/test_local_files.py`
2. Run frontend typecheck: `npm run typecheck` in `desktop/`
3. Verify `GET /api/local-files/check?path=O:\Lawrences Files` returns `exists=True`.
4. Verify non-existent path returns `exists=False`.
