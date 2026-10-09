# Implementation Plan: Note Tags Improvements

## Goal
A) Render project tags with their dynamic project colors instead of static colors.
B) Provide a dropdown style autocomplete for existing tags when adding a tag.

## Branch
Use branch `feat/note-tags-autocomplete`

## 1. Backend: Include Note Tags in `list_tags`
**File:** `backend/main.py`
- Modify the `list_tags(space_id, db)` endpoint. Currently, it only queries `Task.tags`.
- Enhance it to also scan note tags:
  - Get the content directory via `root = spaces.content_dir(space_id)`.
  - Iterate `file_layer.list_notes("**/*.md", notes_dir=root)`.
  - For paths that are not hidden, use `file_layer.read_note(...)["frontmatter"].get("tags")` to extract and merge them into the tags set (using `schemas.clean_tags`). Skip unparseable files with a `try/except`.
  - Return the combined sorted set.

## 2. Dynamic Project Colors for Tags
**File:** `desktop/src/pages/NotePage.tsx`
- In `NoteTags`, retrieve `projects` from `useSpace()`.
- When rendering each `tag` pill, check if it matches a project `code` (case-insensitively).
- If it does, use the project's custom color (`style={{ color: proj.color, borderColor: \`\${proj.color}99\` }}`).
- If it doesn't match or has no custom color, fallback to `LABEL_TAG` styling. 
- Remove reliance on the hardcoded `PROJECT_TAG` map for Note tags.

## 3. Autocomplete Dropdown for Tag Addition
**File:** `desktop/src/pages/NotePage.tsx`
- Upgrade the `adding` state in `NoteTags` to include autocomplete logic.
- When `adding` is true, fetch the available tags via `getJson<string[]>(/api/spaces/${spaceId}/tags)` and store them in state.
- As the user types in the `draft` input, show a dropdown list (using a Popover or absolute list) of matching tags (case-insensitive substring match) that are not already in the note.
- Add keyboard navigation (ArrowDown, ArrowUp) and Enter to pick a tag from the list.
- If the user types a new tag and hits Enter, add the custom typed tag.
- Escape should close the dropdown and cancel adding.
