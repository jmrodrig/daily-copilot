# Implementation Plan: Phase 13 - Merge Duplicate Speakers Tagged as Same Person

## Task ID: phase-13-merge-duplicate-speakers
## Branch: phase-13-merge-duplicate-speakers

---

## 1. Problem Statement & Motivation
- Audio diarization algorithms (clustering acoustic embeddings) can sometimes over-segment a single speaker into two or more distinct cluster IDs (e.g. `Speaker 1` and `Speaker 2`), especially across long meetings, volume shifts, or when speaking after a long pause.
- When the user identifies and tags both clusters as the **same person** (e.g. tagging `Speaker 1` as "Alice" and `Speaker 2` as "Alice"):
  1. **Duplicate inline chips**: The inline `Participants:` list currently maps over all tagged participant objects, rendering duplicate badges (`[Alice] [Alice]`).
  2. **Fragmented participant records**: The data block retains two separate participant records with the same display name rather than unifying them into a single participant.
  3. **Untagging conflict**: Untagging one instance via string replacement on the shared display name reverts all turns, conflicting with the other cluster.
- Requirement:
  - When a speaker is tagged with the same name as an already-tagged participant (or when tagging an unidentified speaker as someone already in the meeting), **merge the duplicate participant records** into a single cohesive participant.
  - Preserve all audio snippets/cluster references so the user can listen to samples from either voice segment.
  - In the inline `Participants:` list, display **one single badge** for that person.
  - In the edit popover for that person, allow listening to any of their audio snippets and managing their tag cleanly.

---

## 2. Architecture & Component Changes

### A. Backend (`backend/voice.py`, `backend/tests/test_voice.py`)
1. **`tag_participant` in `backend/voice.py`**:
   - When tagging `speaker_id` as `alias`:
     - Check if another participant in `block["participants"]` is already tagged with the same `alias` (case-insensitive):
       `existing = next((p for p in participants if p.get("speaker_id") != speaker_id and p.get("display_name", "").strip().lower() == alias.lower() and p.get("is_tagged")), None)`
     - If an existing tagged participant is found:
       - **Merge them**:
         - Retain `existing` as the primary participant record.
         - Combine snippet URLs: store list `snippet_urls: list[str]` (or retain both snippets in a `snippets` array `{ snippet_url, sample_text, cluster_id }`).
         - Ensure `email` is updated if provided.
         - Remove the redundant `target` from `participants`.
         - Replace `**{old_name}:**` with `**{alias}:**` across `dialogue`.
     - If no existing participant has this name:
       - Update `target` in place as usual.
2. **`untag_participant` in `backend/voice.py`**:
   - When untagging a participant:
     - If the participant represents merged clusters (or multiple speaker IDs):
       - Reverts `dialogue` turns and resets `is_tagged: False`.
3. **Backend Unit Tests (`backend/tests/test_voice.py`)**:
   - Add `test_tag_participant_merges_duplicate_speakers`:
     - Start with a block having `Speaker 1` and `Speaker 2`.
     - Tag `Speaker 1` as "Alice".
     - Tag `Speaker 2` as "Alice".
     - Verify: `participants` list now has 1 entry for "Alice" instead of 2.
     - Verify: dialogue contains `**Alice:**` for turns originally belonging to both Speaker 1 and Speaker 2.
     - Verify: snippets for both clusters are preserved.

### B. Frontend (`desktop/src/components/ListenWidget.tsx` & `desktop/src/context/VoiceRecordingContext.tsx`)
1. **Participant Type Extension**:
   - In `VoiceRecordingContext.tsx`, extend `ListenParticipant` to optionally hold:
     ```ts
     snippets?: { snippet_url: string; sample_text?: string; cluster_id?: number | null }[];
     ```
2. **Inline Participants Deduplication & Merged Display**:
   - In `ListenWidget.tsx`, ensure the inline `Participants:` row renders one unique chip per person.
   - In `TaggedParticipant`:
     - If the person has multiple voice snippets (from merged clusters), render audio player controls that allow toggling or playing each snippet (e.g., `Clip 1`, `Clip 2`).
3. **People Picker Suggestions**:
   - In `UntaggedParticipant`, ensure the space's People picker and already-tagged participants are easily selectable so the user can quickly merge an unidentified speaker into an existing meeting participant with one click.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Backend**:
   - Update `tag_participant` in `backend/voice.py` to merge duplicate participants when tagged with the same alias.
   - Update `backend/tests/test_voice.py` with unit tests for merging duplicate speaker clusters.
2. **Frontend (`desktop/src/components/ListenWidget.tsx` & `desktop/src/context/VoiceRecordingContext.tsx`)**:
   - Update `ListenParticipant` type if needed to support multiple snippets/samples.
   - Ensure `TaggedParticipant` popover handles multiple snippets gracefully (allowing the user to play either audio sample).
   - Ensure inline participants list deduplicates by display name as a defense-in-depth guarantee.
3. **Verification**:
   - Run `pytest backend/tests/test_voice.py`.
   - Run full `pytest backend/tests/`.
   - Run `npm run build` in `desktop/`.
   - Commit all changes to branch `phase-13-merge-duplicate-speakers`.

---

## 4. User-Driven Manual Testing Plan
1. **Merge Duplicate Speakers Hands-On Test**:
   - In a note with a recording having at least two unidentified speakers (`Speaker 1` and `Speaker 2`):
   - Tag `Speaker 1` as "Alice" (from People or newly created).
   - Tag `Speaker 2` also as "Alice".
   - **Verify**: The inline `Participants:` row shows **only ONE chip** for "Alice" (no duplicate `[Alice] [Alice]` badges).
   - **Verify**: In the dialogue transcript, all turns from both `Speaker 1` and `Speaker 2` are now cleanly attributed to `**Alice:**`.
   - **Verify**: The "Unidentified speakers" section is now empty and disappears.
2. **Edit Merged Speaker Popover Test**:
   - Click on the "Alice" participant chip.
   - **Verify**: The popover opens and shows player controls for her voice clips.
   - Play the clips to verify both acoustic segments can be reviewed.
   - Change her name to "Alice Smith" and click "Update".
   - **Verify**: The single chip updates to "Alice Smith" and all dialogue turns update cohesively.
