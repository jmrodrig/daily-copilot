# Implementation Plan: URL Pill Enhancements

## Goal
Populate URL link pills with web metadata (title) upon creation, and allow users to edit the URL and display text of existing URL pills.

## Branch
Use branch `feat/url-metadata-edit`

## 1. Backend Metadata Endpoint
**File:** `backend/main.py`
- Create a new endpoint `GET /api/url-metadata?url=...` that fetches the target URL and extracts the `<title>` tag.
- Use `urllib.request` with a basic timeout (e.g., 5 seconds) and a `User-Agent: Mozilla/5.0` to prevent simple blocks. Catch all exceptions gracefully.
- Parse the title using a regex (`r'<title[^>]*>(.*?)</title>'`). Decode HTML entities.
- Return `{"title": "..."}` or `{"title": null}` if it fails. Define a Pydantic model for the response.

## 2. Auto-Populate Display Text
**File:** `desktop/src/components/refPanels.tsx`
- In `LinkPanel`, add a `useEffect` that listens to the computed `url` variable.
- When `url` is valid, call the new `/api/url-metadata` endpoint.
- If a title is returned, automatically `setDisplayText(title)` so the input field is populated with the webpage's title.
- Keep the existing fallback behavior (if metadata fails or takes too long, it defaults to the URL itself).

## 3. Edit Existing URL Pills
**File:** `desktop/src/components/NoteEditor.tsx`
- Create a `PillMenuWrapper` component similar to `BubbleMenuWrapper`.
- It should show a `BubbleMenu` when `editor.isActive("referencePill")` and the node's `kind` attribute is `"url"`.
- The popup should offer an "Edit" toggle.
- When editing, show a small form with two inputs: "Display text" (maps to `label`) and "URL" (maps to `href`).
- Submitting the form runs `editor.chain().focus().updateAttributes("referencePill", { label, href }).run()`.
- Place `<PillMenuWrapper editor={editor} />` inside `NoteEditor` along with the other menus.
