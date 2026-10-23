# Implementation Plan: Phase 13 - Edit Speaker Tagging

## Task ID: phase-13-edit-speaker-tagging
## Branch: phase-13-edit-speaker-tagging

---

## 1. Problem Statement & Motivation
- Once a speaker in a recorded meeting is tagged (either by manual enrollment or auto-matched voiceprint), they appear in the inline `Participants:` list and their name is substituted throughout the dialogue turns.
- Currently, tagged participants are completely static chips. There is **no way to edit or change the speaker tagging**:
  1. If a participant was tagged with the wrong person, or a voiceprint match was incorrect, the user cannot change who the speaker is.
  2. If the user wants to rename the speaker, re-assign them to a different person from the People directory, or add a newly created contact, there is no UI to do so.
  3. If the user wants to remove the tag and reset the speaker back to "unidentified", there is no untag option.
- Requirement: Provide an intuitive, accessible way to **edit speaker tagging** directly from the widget:
  - Allow clicking a tagged participant chip (or an edit action on it) to open an editing popover.
  - In the popover:
    - Listen to their voice snippet (if available) to verify who was speaking.
    - Change/reassign the speaker to any person in the People directory (or create a new Person).
    - Save/update the tag (renaming the speaker across the dialogue transcript and updating the note in place).
    - Or remove the tag / reset to unidentified (moving the speaker back to the Unidentified Speakers section).

---

## 2. Architecture & Component Changes

### A. Backend (`backend/voice.py`, `backend/schemas.py`, `backend/main.py`, `backend/tests/test_voice.py`)
1. **`backend/voice.py`**:
   - `untag_participant(block: dict[str, Any], speaker_id: str) -> dict[str, Any]`:
     - Finds the participant with `speaker_id`.
     - Resets `display_name` to `speaker_id` (e.g. "Speaker 1"), sets `is_tagged = False`, clears `email`.
     - Replaces `**{old_name}:**` with `**{speaker_id}:**` throughout the dialogue markdown.
     - Returns the updated block.
   - Note: `tag_participant(...)` already supports re-tagging (renaming an existing tagged participant from Person A to Person B, updating the dialogue and note block).
2. **`backend/schemas.py`**:
   - Add `VoiceUntagRequest`:
     ```python
     class VoiceUntagRequest(BaseModel):
         speaker_id: str = Field(min_length=1, max_length=64)
         block: dict[str, Any] = Field(default_factory=dict)
         widget_id: str | None = Field(default=None, pattern=_WIDGET_ID)
         space_id: int = 1
         note_path: str | None = None
     ```
3. **`backend/main.py`**:
   - Add `POST /api/voice/untag-participant`:
     ```python
     @app.post("/api/voice/untag-participant")
     def untag_voice_participant(request: schemas.VoiceUntagRequest) -> schemas.VoiceTagResponse:
         """Remove a participant's tag: reset them back to untagged, revert their dialogue turns, and update the note block."""
         def untag(block: dict[str, Any]) -> dict[str, Any]:
             return voice.untag_participant(block, request.speaker_id)
         written = _write_listen_block(request.space_id, request.note_path, request.widget_id, untag)
         block = untag(request.block) if request.block else (written or {})
         return schemas.VoiceTagResponse(
             block=block, note_updated=written is not None, has_untagged=voice.has_untagged(block), contact={}
         )
     ```
4. **Backend Tests (`backend/tests/test_voice.py`)**:
   - Test re-tagging an already-tagged participant (renaming from Person A to Person B in dialogue and block).
   - Test untagging a participant (reverting to speaker_id in dialogue, setting is_tagged=False, updating note).

### B. Frontend (`desktop/src/components/ListenWidget.tsx`)
1. **Interactive `TaggedParticipant` Chip & Edit Popover**:
   - Make `TaggedParticipant` clickable when `interactive` is true.
   - Add hover styling (`hover:border-emerald-500/70 hover:bg-emerald-500/20 cursor-pointer`) and a subtle edit pencil icon or indicator, with `title="Click to edit speaker tagging"`.
   - When clicked: opens a Popover anchored to the participant chip.
2. **Edit Popover Contents**:
   - Header with current name: `Edit Speaker` / `{participant.display_name}`.
   - **Voice Snippet Player**: If `participant.snippet_url` is present, display a Play Snippet button so the user can hear the speaker's voice to confirm their identity.
   - **People Directory Picker**:
     - Pre-filled or searchable combobox using the space's People directory (`people`).
     - Allows picking another person or typing a new name with `+ Add "[Name]" to People`.
   - **Actions**:
     - **"Update" button**: Calls `POST /api/voice/tag-participant` with the new person's name and email, updates the block, renames all dialogue turns, and updates the widget.
     - **"Remove tag" / "Reset to Unidentified" button**: Calls `POST /api/voice/untag-participant`, which sets `is_tagged: false` and moves the speaker back to the "Unidentified speakers" section.
     - **"Cancel" / Escape**: Closes popover without changes.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Backend**:
   - In `backend/voice.py`, implement `untag_participant(block, speaker_id)`.
   - In `backend/schemas.py`, add `VoiceUntagRequest`.
   - In `backend/main.py`, add `POST /api/voice/untag-participant`.
   - In `backend/tests/test_voice.py`, add unit tests for re-tagging and untagging.
2. **Frontend (`desktop/src/components/ListenWidget.tsx`)**:
   - Update `TaggedParticipant` to accept `data`, `people`, `interactive`, `note`, `onTagged`.
   - Implement the edit popover with People picker, snippet audio playback, "Update Tag", and "Remove Tag".
   - Wire `POST /api/voice/tag-participant` for updating/re-tagging, and `POST /api/voice/untag-participant` for removing the tag.
   - When re-tagged, update state via `onTagged`. When untagged, update state via `onTagged` (the speaker moves back to Unidentified speakers).
3. **Verification**:
   - Run `pytest backend/tests/test_voice.py`.
   - Run full `pytest backend/tests/`.
   - Run `npm run build` in `desktop/`.
   - Commit all changes to branch `phase-13-edit-speaker-tagging`.

---

## 4. User-Driven Manual Testing Plan
1. **Edit Speaker Tag (Reassigning to Another Person)**:
   - Open a note with a completed recording where a speaker is tagged (e.g. "Arthur Dent").
   - Click on the "Arthur Dent" participant chip in the inline `Participants:` list.
   - **Verify**: An edit popover opens showing Arthur Dent, a Play snippet button (if snippet exists), and the People picker.
   - Play the snippet to hear the speaker's voice.
   - In the People picker, select a different person (e.g., "Ford Prefect") or type a new person name.
   - Click "Update" / "Save".
   - **Verify**: The participant chip updates to "Ford Prefect".
   - **Verify**: In the dialogue transcript below, all turns previously attributed to "Arthur Dent" are now attributed to "Ford Prefect".
2. **Remove Tag / Reset to Unidentified**:
   - Click on the "Ford Prefect" participant chip again.
   - Click "Remove tag" / "Reset to unidentified".
   - **Verify**: The chip disappears from the inline `Participants:` row.
   - **Verify**: The "Unidentified speakers" section appears, showing the speaker with their audio snippet and picker, ready to be tagged again.
   - **Verify**: The dialogue turns revert from "Ford Prefect" to "Speaker 1" (or the original cluster label).
