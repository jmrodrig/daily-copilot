# Implementation Plan: Chat Attachments & PDF Viewer Continuous Scrolling

**Task ID:** `chat-attachments-and-pdf-viewer`  
**Branch:** `feat/chat-attachments-and-pdf-viewer`

---

## 1. Objectives

1. **Attach Documents Directly to Copilot Chat**:
   - Users can attach documents (PDFs, images, text files, spreadsheets, etc.) directly in the Copilot chat composer via:
     - A paperclip 📎 button in the composer toolbar.
     - Drag-and-drop onto the composer.
     - Clipboard paste (Ctrl+V) when files are on the clipboard.
   - Uploaded files are stored in the active space's asset directory (`.assets/`) and served securely via `/api/notes/image/<hash>.<ext>?space_id=<id>`.
   - The user message displays interactive attachment pills with file names, sizes, and icons.
   - Clicking a PDF or image attachment pill opens it immediately in the `MediaLightbox`.
   - The backend LLM/CLI agent receives the attachment metadata, disk path, and extracted content (for text/PDFs) so it can directly analyze and answer questions about the attached document.
   - Chat history cross-device synchronization preserves attachments.

2. **PDF Viewer Improvements**:
   - **Continuous Scrolling**: In `MediaLightbox`, multipage PDFs are rendered in a continuous vertical column. All pages are sequentially laid out with page margins/gaps.
   - **Mouse Wheel Scrolling**: Normal mouse wheel scroll (without Ctrl) scrolls down and up continuously through document pages.
   - **Ctrl + Mouse Wheel / Pinch Zoom**: Holding `Ctrl` while scrolling the mouse wheel (or trackpad pinch gesture with `e.ctrlKey`) zooms in and out centered at the cursor position.
   - **Active Page Tracking**: As the user scrolls through the document, the footer's page indicator (`page / total`) dynamically updates to reflect whichever page is currently in view.
   - **Page Navigation**: Clicking `‹` and `›` in the footer scrolls smoothly to the previous/next page.
   - **Page-Level Virtualization**: Non-visible pages outside a generous viewport buffer render lightweight placeholder boxes to ensure smooth performance even for large documents.

---

## 2. Proposed Architecture & File Changes

### Backend Changes

1. **`backend/schemas.py`**:
   - Define `ChatAttachment`:
     ```python
     class ChatAttachment(BaseModel):
         name: str
         url: str
         size: int | None = None
         content_type: str | None = None
     ```
   - Update `ChatMessage`:
     ```python
     class ChatMessage(BaseModel):
         role: ChatRole
         content: str
         attachments: list[ChatAttachment] = Field(default_factory=list)
     ```
   - Ensure `ChatThread` history models (`ChatHistoryPayload`, `ChatHistoryResponse`) preserve `attachments` on user entries.

2. **`backend/agent.py`**:
   - In `_cli_prompt()`:
     When formatting user messages, inspect `message.attachments`.
     For each attachment:
     - Parse the filename from `att.url` (`.assets/<hash>.<ext>`).
     - Resolve local disk path: `turn.root / ".assets" / asset_name`.
     - Append an attachment block to the prompt:
       ```
       [Attached file: "{att.name}" (size: {att.size} bytes, local path: {asset_path.resolve()})]
       ```
     - For text files (`.txt`, `.md`, `.csv`, `.json`), if under 32KB, embed the content directly in the prompt.
     - For PDFs, extract the text using `pymupdf` (up to a limit) or instruct the agent to use `Read` / `read_local_file` with the provided path.
   - Ensure LiteLLM, Claude CLI, and Gemini CLI prompt builders include the attachment references.

3. **`backend/tests/test_chat_attachments.py`**:
   - Add unit tests verifying `ChatMessage` with attachments, prompt construction with local asset paths, and chat history round-trip with attachments.

---

### Desktop Frontend Changes

1. **`desktop/src/components/MediaLightbox.tsx`**:
   - **Multipage Viewports**:
     When a PDF document is loaded (`pdf`):
     - Query viewports for all pages (`pdf.getPage(i + 1)`).
     - Store array of page geometries `{ width, height, y }`, `maxWidth`, and `totalHeight`.
   - **Wheel Handler**:
     ```typescript
     const wheel = (e: WheelEvent) => {
       e.preventDefault();
       if (e.ctrlKey || e.metaKey) {
         zoomTo(viewRef.current.zoom * Math.exp(-e.deltaY / 400), { x: e.clientX, y: e.clientY });
       } else {
         const dx = e.shiftKey ? e.deltaY : e.deltaX;
         const dy = e.shiftKey ? 0 : e.deltaY;
         setView((v) => ({
           ...v,
           x: v.x - dx,
           y: v.y - dy,
         }));
       }
     };
     ```
   - **Continuous Page Stack**:
     Render all pages in a vertical column centered inside the transformed stage container.
     Use an `IntersectionObserver` or distance check per page to only render `<canvas>` for pages near the viewport, displaying a sized placeholder otherwise.
   - **Active Page Detection**:
     Track the page closest to the stage center based on `view.y` and update `setPage(activePageIndex)` so the footer page counter reflects the visible page.
   - **Footer `‹` / `›` Buttons**:
     When clicked, smoothly scroll to bring the target page to the top/center of the view.

2. **`desktop/src/components/CopilotChat.tsx`**:
   - **State**:
     - `pendingAttachments: ChatAttachment[]`
     - `uploadingAttachments: boolean`
   - **File Upload Handler**:
     - Uses `FormData` to post files to `/api/notes/image` with `space_id`.
     - Appends uploaded file metadata `{ name, url, size, content_type }` to `pendingAttachments`.
   - **Composer UI**:
     - Add paperclip button `📎` to composer bar.
     - Add hidden `<input type="file" multiple ref={fileInputRef} />`.
     - Support drag-and-drop on composer with visual hover state.
     - Support paste (Ctrl+V) of files/images.
     - Render pending attachment chips above the textarea with remove `×` buttons and upload indicator.
   - **Message Rendering**:
     - In user chat entries, render attachment badges/pills.
     - Clicking a PDF or image opens `MediaLightbox`.
     - Clicking other files opens/downloads the URL.
   - **Payload Serialization**:
     - Include `attachments` in the message object passed to `/api/chat/stream`.
     - Store `attachments` in `Entry` and `ChatThread` history for persistence across devices and sessions.

---

## 3. Verification & Testing

### Automated Tests
1. `pytest backend/tests/test_chat_attachments.py` & full test suite `pytest backend/tests`.
2. Frontend typecheck: `npm run typecheck` in `desktop/`.
3. Frontend build: `npm run build` in `desktop/`.
4. Playwright tests:
   - Create `desktop/tests/chat-attachments.spec.ts`: test attaching a file, verifying pill display, and mock stream response.
   - Create `desktop/tests/pdf-continuous-scroll.spec.ts`: test multipage PDF wheel scroll without Ctrl, Ctrl+wheel zoom, and page indicator tracking.

### Manual, User-Driven Testing Gate (Mandatory)
1. **Dev Servers Launch**:
   Run `python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload` in `backend/` and `npm run dev` in `desktop/`.
2. **Chat Attachments**:
   - Open Copilot chat in the desktop UI.
   - Click the paperclip icon and select a PDF or image file (or drag a file onto the chat input).
   - Observe the attachment chip in the composer showing the filename and size. Click `×` to test removing an attachment.
   - Re-attach a PDF and type: "Please summarize this document".
   - Press Send:
     - Verify the user message has an attachment pill.
     - Click the attachment pill: verify that `MediaLightbox` opens with the PDF document.
     - Verify the assistant answers referring to the document's content.
3. **PDF Viewer Continuous Scrolling & Zoom**:
   - In `MediaLightbox` with a multipage PDF open:
     - Scroll the **mouse wheel down**: verify it scrolls smoothly down through pages 1, 2, 3...
     - Observe the footer counter (`Page X / Y`) update as different pages scroll into view.
     - Hold **Ctrl** and scroll the mouse wheel (or trackpad pinch): verify it zooms smoothly in and out centered on the cursor.
     - Click the `›` and `‹` buttons in the footer: verify the viewer scrolls to the next/previous page.
