# Implementation Plan: Local Files & Agent Crawling

## Branch
Use branch `feat/local-files`

## Part A: Local File Links in Markdown

### 1. Backend APIs (`backend/main.py` & `backend/local_files.py`)
- Create `backend/local_files.py` to encapsulate local file operations.
- Add FastAPI endpoints in `main.py`:
  - `POST /api/local-files/open`: Accepts `{ path: string }`. Uses `os.startfile(path)` (Windows) or `subprocess.Popen(["xdg-open", path])` (Linux/Mac) to open the file/folder locally.
  - `GET /api/local-files/stat`: Accepts `?path=...`. Returns `{ name: string, type: "file" | "directory", size: number }`.
  - `GET /api/local-files/download`: Accepts `?path=...`. Returns a `fastapi.responses.FileResponse` for the file.
  - `GET /api/local-files/download-zip`: Accepts `?path=...`. Uses `tempfile` and `shutil.make_archive` (or `zipfile`) to stream a ZIP of the directory.

### 2. Frontend Styling (`desktop/src/index.css`)
- Replicate the `.note-body a[href*="/api/notes/image/"]` pill styling for local files: `.note-body a[href^="file://"], .note-body a[href^="C:\\"], .note-body a[href^="\\\\"]` (and handle standard Windows/Unix absolute paths).
- Use a different `mask-image` (e.g., a folder or hard drive icon) for the `::before` pseudo-element for these local links.
- Update `a:not(...)` so local links get the pill style instead of the standard blue underline.

### 3. Frontend Link Click Handling (`desktop/src/components/NoteEditor.tsx`)
- In `BubbleMenuWrapper` or a dedicated click handler for the editor view:
- Detect if a clicked link is a local file path (`startsWith("file://")` or matches a Windows path).
- When clicked, prevent default and check if `window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"`.
- **If Localhost:** Call `POST /api/local-files/open` with the path.
- **If Remote Client:** 
  - Call `GET /api/local-files/stat?path=...`.
  - Show a confirmation `window.confirm` or a custom modal: "Download [name] ([size in MB] MB)?".
  - If accepted, trigger the download via `window.open` or an invisible `<a>` tag targeting `/api/local-files/download` (or `download-zip` if it's a directory).

### 4. Link Extension (`desktop/src/components/NoteEditor.tsx`)
- Ensure the Tiptap `Link` extension (`StarterKit.configure({ link: { ... } })`) allows `file:` protocol, or manually configure the `Link` extension to accept all protocols so local paths aren't stripped.

## Part B: Agent File Crawling & Reading

### 1. Agent Tools (`backend/local_files.py` & `backend/agent.py`)
- In `backend/local_files.py`, implement two helper functions for the AI:
  - `list_local_directory(path: str)`: Lists files and subdirectories in a given path. Returns a formatted string or JSON list of `{ name, type, size }`.
  - `read_local_file(path: str)`: Reads the content of a file.
    - If it's a text file (`.txt`, `.md`, `.csv`, `.json`), read it as text.
    - If it's a PDF (`.pdf`), use the installed `pymupdf` (`import fitz`) to extract the text.
    - If it's another binary format (Word, Excel, CAD, Maxsurf), gracefully return metadata (size, created date) and a message that text extraction for this format is not supported yet.
- In `backend/agent.py`, expose these two functions as tools (`list_local_directory`, `read_local_file`) to the Litellm agent. Add their schemas to the `TOOLS` list and route their calls in the execution loop. Update the system prompt to explicitly inform the agent it can crawl the local file system using these tools to find design data (PDFs, CAD files, Maxsurf, etc.).
