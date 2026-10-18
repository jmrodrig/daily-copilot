# Implementation Plan: Phase 13 - Participants Inline Display & People Directory Picker

## Task ID: phase-13-participants-inline-and-people-picker
## Branch: phase-13-participants-inline-and-people-picker

---

## 1. Problem Statement & Motivation
1. **People Directory Integration for Speaker Tagging**:
   - Currently in `desktop/src/components/ListenWidget.tsx`, `UntaggedParticipant` only suggests names from `/api/voice/contacts` (a list of audio voiceprint contacts) using a raw HTML `<datalist>`.
   - It is disconnected from the workspace's primary **People directory** (`/api/people`, `desktop/src/lib/people.tsx`).
   - The user requested:
     1. When identifying/tagging participants in the widget, pick up the workspace's **People list** (`usePeople(spaceId)` / `GET /api/people`).
     2. If the person is not on the list, allow creating a new person right from the participant tagger (adding them to `/api/people` with `announcePeopleChange()`) and tagging the speaker with that person.
2. **Inline Participants Display**:
   - Once participants are determined (tagged with an identity or recognized by voiceprint), they were previously rendered in a vertical column (`flex flex-col gap-2`), with each participant taking up a full row.
   - The user requested: once participants are determined, show them **inline** (horizontal wrapping badge list) instead of in a column, keeping the widget compact and visually clean.

---

## 2. Architecture & Component Changes

### A. Inline Participants Display (`desktop/src/components/ListenWidget.tsx`)
1. In the `Completed` component of `ListenWidget.tsx`:
   - Split `participants` into `tagged` (determined identities where `p.is_tagged` is true) and `untagged` (unidentified speakers like "Speaker 1").
   - **Determined Participants**: Rendered **inline** in a horizontal wrapping flex container:
     - Container: `flex flex-wrap items-center gap-2 pt-1`.
     - Label: `Participants:` in muted monospace tracking.
     - Each participant is an inline pill/chip:
       - Displays initials avatar (`<Avatar person={person} />` if in People, or emerald check icon).
       - Person's display name.
       - Optional compact email or hover title with full contact info.
       - Styling: neat rounded pill (`rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[13px] text-emerald-400`).
   - **Unidentified Speakers**: If there are untagged speakers, show them in a dedicated `Unidentified Speakers` section below or alongside, with the snippet player and participant picker. Once tagged, they move immediately to the inline determined list.

### B. People Directory Picker & New Person Creation (`desktop/src/components/ListenWidget.tsx`)
1. Connect to workspace People:
   - Use `usePeople(note?.spaceId ?? 1)` from `../lib/people` to retrieve all known People in the active space.
2. Participant Picker Component (`ParticipantPicker` / `UntaggedParticipant`):
   - Replace the plain text `<input list={listId}>` with an interactive People combobox / picker:
     - Type to search / filter existing People in the space (matching by name or email).
     - Renders suggestions dropdown with Avatar, name, and email.
     - **If not in People**:
       - When the user types a name not currently in the directory, offer an option:  
         `+ Add "[Typed Name]" to People` (or a "+ New Person" button).
       - Clicking it calls `POST /api/people` with `{ space_id: spaceId, name: typedName.trim(), is_external: false }`.
       - Calls `announcePeopleChange()` to refresh all People components app-wide.
       - Immediately sets this newly created person as the selected identity.
3. Tagging & Voiceprint Enrollment:
   - When a person is selected (from existing People or newly created):
     - Automatically uses `person.name` as `alias` and `person.email` as `email`.
     - Calls `POST /api/voice/tag-participant` to enrol the voiceprint embedding in `voice.py` and update the note dialogue turns in place.
     - Calls `onTagged(response.block, response.note_updated)` to update the widget state in TipTap.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Update `desktop/src/components/ListenWidget.tsx`**:
   - Import `usePeople`, `Avatar`, `announcePeopleChange`, `type Person` from `../lib/people`.
   - In `Completed`:
     - Load `people = usePeople(note?.spaceId ?? 1)`.
     - Partition `participants` into `tagged` and `untagged`.
     - Render `tagged` participants **inline** using `flex flex-wrap items-center gap-2`.
     - Render `untagged` participants with the enhanced People picker.
   - In `UntaggedParticipant`:
     - Provide an accessible search/dropdown combobox driven by `people`.
     - Include `+ Add "[Name]" to People` option when a typed name isn't in `people`.
     - When adding a new person:
       - Send `POST /api/people` with `{ space_id, name }`.
       - On success, call `announcePeopleChange()`.
       - Proceed to `POST /api/voice/tag-participant` with `alias: person.name, email: person.email`.
     - When selecting an existing person:
       - Call `POST /api/voice/tag-participant` with `alias: person.name, email: person.email`.
2. **Verification & Tests**:
   - Verify TypeScript compilation via `npm run build` in `desktop/`.
   - Run backend tests via `pytest backend/tests/test_voice.py`.
   - Ensure all changes are committed cleanly to branch `phase-13-participants-inline-and-people-picker`.

---

## 4. User-Driven Manual Testing Plan
1. **People Picker & Add New Person Verification**:
   - Open a note containing a completed recording with unidentified speakers (or record a short test).
   - In the "Unidentified Speakers" section, click the name input for a speaker.
   - **Verify**: A dropdown appears listing existing People from the space (with avatars/initials).
   - Select an existing Person from the list and click "Tag & Enroll".
   - **Verify**: The speaker is tagged with that person's name, and moves into the inline participants list.
   - For another unidentified speaker, type a new name (e.g., "Sarah Connor") that does not exist in People.
   - **Verify**: The dropdown shows `+ Add "Sarah Connor" to People`.
   - Click it or submit to tag.
   - **Verify**: The person is created in the space's People directory (visible at `/people`), the speaker is tagged, and enrolled with that voiceprint.
2. **Inline Display Verification**:
   - Look at the determined participants list.
   - **Verify**: All tagged/identified participants are displayed **inline horizontally** (wrapping if necessary) as clean badges/chips, rather than stacked vertically in a column.
   - Once all speakers are tagged, **Verify**: The "Unidentified Speakers" section cleanly disappears, leaving only the compact inline participants row and the transcript.
