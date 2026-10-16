# Implementation Plan: Note Reference Pills & Cross-Device Chat History Sync

**Target Components:**
1. `desktop/src/components/referencePill.tsx` (Inference of pill kind from href, relaxed markdown tokenizer, space-aware note navigation)
2. `desktop/src/pages/NotePage.tsx` (Inferred pill rendering and relative note path normalization)
3. `backend/agent.py` (Prompt instructions for reference pill formatting with note/task/local links)
4. `backend/schemas.py` & `backend/main.py` (`GET /api/chat/history` and `PUT /api/chat/history` endpoints with atomic file storage per space)
5. `desktop/src/components/CopilotChat.tsx` (Multi-device chat history synchronization, remote merge, and background focus sync)

---

## 1. Problem Statement

1. **Reference Pills Not Formatting**:
   - Reference pills in both read-only view (`NotePage.tsx`) and the WYSIWYG editor (`NoteEditor.tsx`) currently require an explicit markdown title: `[Title](url "ref:task|note|url")`.
   - When Co-pilot writes or edits notes, it generates standard markdown links (e.g. `[Rig loads](C7801/Rig loads.md)` or `[Task #12](/tasks/backlog?taskId=12)`), omitting the `"ref:..."` title.
   - In view mode (`NotePage`), these render as plain blue text links. Clicking relative note links fails because they are not formatted as `/note?space=<id>&path=<encoded>`.
   - In edit mode (`NoteEditor`), Tiptap's markdown tokenizer ignores them and parses them as ordinary link marks instead of interactive `referencePill` atom nodes.
   - The Co-pilot's system prompt and write guides contain no instructions on how reference pills should be formatted.

2. **Chat History Isolated Per Device**:
   - `CopilotChat.tsx` stores chat threads solely in browser `localStorage`.
   - Because `localStorage` is device-local, accessing the Daily Co-Pilot from another PC, laptop, or mobile tablet results in a completely disconnected chat history.
   - The backend does not currently have endpoints to persist or retrieve chat threads per space.

---

## 2. Proposed Changes

### Part A: Reference Pill Formatting & Inference

#### 1. `desktop/src/components/referencePill.tsx`
- **Enhance `refKind(title, href)`**:
  - If `title` matches `^ref:(task|note|url)$`, return that kind.
  - If no title match, infer from `href`:
    - `taskIdFromHref(href) !== null || /taskId=\d+/.test(href) || /^\/tasks\/\d+/.test(href)` $\rightarrow$ `"task"`
    - `href.startsWith("/note?") || href.startsWith("/notes?") || /\.md($|[?#])/i.test(href)` $\rightarrow$ `"note"`
    - `isLocalHref(href)` $\rightarrow$ `"url"`
    - Otherwise $\rightarrow$ `null` (regular web link).
- **Update `ReferencePill.markdownTokenizer`**:
  - Update `PILL` regex to optionally match titles:
    `const PILL = /^\[((?:\\.|[^\\\]\n])*)\]\(<?([^\n"()]+?)>?(?:\s+"ref:(task|note|url)")?\s*\)/;`
  - In `tokenize(src)`:
    - Extract `rawTitle = match[3] ? \`ref:${match[3]}\` : null`.
    - Extract `href = decodeHref(match[2].trim())`.
    - Check `kind = refKind(rawTitle, href)`.
    - If `kind` is null, return `undefined` (let standard link markdown parser handle it).
    - Otherwise, return `{ type: "referencePill", raw: match[0], label: unescapeLabel(match[1]), href, kind }`.
- **Space-Aware Navigation in `PillView`**:
  - In `PillView.open()`: if `kind === "note"` and `href` does not start with `/note?`, navigate to `notePath(spaceId, href)`.

#### 2. `desktop/src/pages/NotePage.tsx`
- In `NOTE_COMPONENTS.a`:
  - Pass `props.title` and `props.href` to `refKind(props.title, props.href)`.
  - When `kind === "note"`, compute `target = props.href.startsWith("/note?") ? props.href : notePath(spaceId, props.href)`.
  - Render as `<Link to={target} className="reference-pill note">`.

#### 3. `backend/agent.py`
- In `SYSTEM_PROMPT`, `_WRITE_GUIDE`, and `_CLI_WRITE_PROTOCOL`:
  - Add explicit reference pill guidelines:
    - Tasks: `[Task title](/tasks/backlog?taskId=<id> "ref:task")`
    - Notes: `[Note title](/note?space={space_id}&path=<encoded_path> "ref:note")` or `[Note title](<relative_path>.md "ref:note")`
    - Local files: `[File name](<local_path> "ref:url")`
    - External URLs: `[Site name](https://... "ref:url")`
  - Ensure `space_id` is passed to `SYSTEM_PROMPT.format(...)`.

---

### Part B: Cross-Device Chat History Sync

#### 1. Backend Schemas & Endpoints (`backend/schemas.py`, `backend/main.py`)
- In `backend/schemas.py`:
  - `ChatHistoryPayload`: `{ space_id: int, threads: list[dict[str, Any]], active_id: str | None = None }`
  - `ChatHistoryResponse`: `{ space_id: int, threads: list[dict[str, Any]], active_id: str | None = None }`
- In `backend/main.py`:
  - `GET /api/chat/history?space_id=<int>`:
    - Reads `<data_dir>/spaces/<space_id>/chat_history.json`.
    - If file does not exist, returns `{ space_id, threads: [], active_id: null }`.
  - `PUT /api/chat/history`:
    - Writes payload atomically using `.tmp` and rename to `<data_dir>/spaces/<space_id>/chat_history.json`.

#### 2. Frontend Chat Sync (`desktop/src/components/CopilotChat.tsx`)
- **Initial Load & Space Switch**:
  - Immediately read local history from `localStorage` for instant display.
  - Asynchronously fetch `GET /api/chat/history?space_id=${spaceId}`.
  - Merge local and remote threads by `id`:
    - For threads in both, select the version with newer `updatedAt`.
    - Preserve local-only threads (e.g. from existing single-device usage) and remote-only threads.
    - Set merged history in state and cache in `localStorage`.
    - If merged set has changes compared to remote, debounce sync to `PUT /api/chat/history`.
- **Debounced Remote Sync on Changes**:
  - Whenever `history` updates (message sent, reply completed, edit applied, chat deleted, thread changed):
    - Save to `localStorage`.
    - Debounce `sendJson("PUT", "/api/chat/history", ...)` by 1000ms.
- **Window Focus Background Sync**:
  - On `window.addEventListener("focus", ...)`, re-fetch remote history and merge if updated remotely.

---

## 3. Verification & Testing

1. **Backend Tests**:
   - Run `pytest backend/tests` to verify no regressions in chat, spaces, or tools.
   - Add unit test verifying `GET /api/chat/history` and `PUT /api/chat/history`.
2. **Frontend Build**:
   - Run `npm run build` in `desktop/` to verify zero TypeScript errors.
3. **Automated End-to-End Test (Playwright)**:
   - Verify that markdown links in notes without title (e.g. `[Test Note](C7801/Test.md)`) render with `.reference-pill.note` in `NotePage`.
   - Verify that chat history written via API syncs and persists across separate client instances.
