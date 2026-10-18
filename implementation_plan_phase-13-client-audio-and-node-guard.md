# Implementation Plan: Phase 13 - Client Audio Capture & Widget Node Guard

## Task ID: phase-13-client-audio-and-node-guard
## Branch: phase-13-client-audio-and-node-guard

---

## 1. Problem Statement & Motivation
1. **Node Replacement on Keypress (Issue 1)**:
   - When any block widget (`listen` or `whiteboard`) is selected in the TipTap editor (displaying the yellow selection outline `NodeSelection`), pressing ANY key (typing a character, Enter, Space, Backspace, or Delete) currently deletes/replaces the entire widget immediately without any prompt.
   - Previously, `ListenRemovalGuard` only guarded `listen` nodes that were actively recording on the backend or completed; it completely ignored `whiteboard` nodes and idle listen widgets.
   - Requirement: Block any keystroke or edit that would remove or replace a selected `listen` or `whiteboard` widget, prompting the user with a confirmation modal (`WidgetRemovalDialog`) detailing what will be lost. If the user cancels or keeps the widget, the keypress/transaction is cancelled. If active, warn that recording is currently in progress.

2. **Microphone Capture on Remote Client (Issue 2)**:
   - When accessing the Copilot web app remotely (e.g. over Tailscale at `http://100.125.227.113:5173/`), recording was previously done via host workstation physical hardware (`pyaudiowpatch` / `sounddevice`), capturing the empty office room rather than the remote client's microphone. This resulted in silence and "no speech detected".
   - Requirement: Audio capture must use **local client resources** in the browser:
     - Microphone: `navigator.mediaDevices.getUserMedia({ audio: true })`.
     - System audio: `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })` (retaining audio track).
     - Mixed: Web Audio `AudioContext` mixing both local mic and system audio.
     - Recording: `MediaRecorder` collecting WebM/Opus audio chunks in the browser.
     - Stop & Transcribe: On Stop, upload the client-recorded audio blob to `POST /api/voice/transcribe` with `widget_id`, `space_id`, `note_path`, and `source`.
     - Backend: Update `POST /api/voice/transcribe` so that when `widget_id` and `note_path` are passed, it updates the existing widget block in the note in place rather than appending a new block.

---

## 2. Architecture & Component Changes

### A. Backend (`backend/main.py` & `backend/tests/test_voice.py`)
1. **`POST /api/voice/transcribe` Enhancement**:
   - Add parameters `widget_id: str | None = Form(None)` and `source: str = Form("mic")`.
   - When `widget_id` and `note_path` are provided:
     - Generate `block = voice.completed_block(widget_id, source, result)`.
     - Call `_write_listen_block(space_id, note_path, widget_id, lambda _old: block)` to update the existing block in place in the note on disk.
     - Return `schemas.VoiceResult.model_validate({**block, "note_updated": written is not None, "note_path": note_path})`.
   - When `widget_id` is NOT provided:
     - Retain existing behavior (generate `lw_<token>`, append to note or create new note in inbox).
2. **Backend Unit Tests**:
   - In `backend/tests/test_voice.py`, add `test_transcribe_upload_updates_existing_widget_block` verifying in-place block updates.

### B. Client Audio Recording (`desktop/src/context/VoiceRecordingContext.tsx` & `desktop/src/lib/clientAudio.ts`)
1. **Create `desktop/src/lib/clientAudio.ts`**:
   - `startClientAudioRecording(source: VoiceSource, options?: { micDeviceId?: string })`:
     - Checks `navigator.mediaDevices?.getUserMedia`.
     - Captures microphone via `getUserMedia({ audio: ... })`.
     - Captures system audio via `getDisplayMedia({ audio: true, video: true })` (cleaning up video track immediately).
     - If `mixed`, combines via `AudioContext` destination.
     - Creates `MediaRecorder` with best supported mimeType (`audio/webm;codecs=opus`, `audio/webm`, etc.).
     - Returns recorder controller with `pause()`, `resume()`, `stop(): Promise<Blob>`, `getStream()`, `cleanup()`.
   - `listClientAudioInputs()`:
     - Calls `navigator.mediaDevices.enumerateDevices()` to list local input devices.
2. **Update `VoiceRecordingContext.tsx`**:
   - Update `start()` to record client audio using `clientAudio.ts`:
     - Sets local status `is_recording: true`, `source`, `widget_id`, `space_id`, `note_path`.
     - Broadcasts state over `BroadcastChannel("copilot:voice")`.
     - Updates title status (`🔴 Listening (00:05)`).
   - Update `pause()` and `resume()` to pause/resume `MediaRecorder`.
   - Update `stop()`:
     - Stops `MediaRecorder` and cleans up tracks.
     - Sets `is_processing: true, stage: "Uploading audio for offline transcription..."`.
     - Creates `FormData` with audio blob, `widget_id`, `space_id`, `note_path`, `source`.
     - Calls `POST /api/voice/transcribe`.
     - Updates `results[widget_id]` with the returned `VoiceResult`.
     - Resets state to idle.
   - If `navigator.mediaDevices` is not available, surface clear guidance toast/error.

### C. Audio Device Picker (`desktop/src/components/ListenWidget.tsx`)
1. Instead of only querying host backend devices, query `listClientAudioInputs()` so the local client's actual microphones are displayed in the device picker.
2. Provide standard options:
   - Default microphone
   - Local client microphones (by name)
   - System audio (Teams / calls)
   - Mixed (Microphone + System Audio)

### D. Block Node Replacement Guard (`desktop/src/components/NoteEditor.tsx` & `desktop/src/extensions/WidgetRemovalGuard.ts`)
1. **Unify Guard for Both `listen` and `whiteboard`**:
   - Guard against ANY transaction that removes a `listen` or `whiteboard` node.
   - Define:
     ```ts
     export type WidgetRemoval =
       | { type: "listen"; reason: "listening" | "recorded" | "idle"; id: string }
       | { type: "whiteboard"; id: string };
     ```
   - In `filterTransaction(tr)`:
     - If `tr.getMeta(WIDGET_REMOVAL_CONFIRMED)`: let it through.
     - Check before vs after docs.
     - If any `listen` node was removed:
       - Check if it is currently listening -> reason `"listening"`.
       - Check if it contains audio / completed transcript -> reason `"recorded"`.
       - Otherwise -> reason `"idle"`.
     - If any `whiteboard` node was removed -> type `"whiteboard"`.
     - If a removal occurred: block transaction (`return false`), invoke `onBlocked(tr, removal)`.
2. **`WidgetRemovalDialog`**:
   - Render confirmation modal with appropriate messaging:
     - **Active Listening**: "The widget is still listening. Removing or replacing it will interrupt the recording and all recording will be lost. Do you want to proceed?"
     - **Recorded Meeting**: "This note contains recorded meeting audio and transcript. Removing or replacing it will delete the recording from the note. Do you want to proceed?"
     - **Idle Listen**: "Removing or replacing this widget will delete it from the note. Do you want to proceed?"
     - **Whiteboard**: "This whiteboard and any drawings in it will be deleted from the note. Do you want to proceed?"
   - "Keep Widget" button is focused by default; pressing Escape or Enter keeps the widget safe.
   - "Interrupt & Remove" / "Remove" button dispatches `tr.setMeta(WIDGET_REMOVAL_CONFIRMED, true)`.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Backend**:
   - Update `transcribe_upload` in `backend/main.py` to support `widget_id: str | None = Form(None)` and `source: str = Form("mic")`. If `widget_id` and `note_path` are present, update existing block in place using `_write_listen_block`.
   - Add unit test in `backend/tests/test_voice.py` verifying in-place update.
2. **Client Audio Capture (`desktop/src/lib/clientAudio.ts`)**:
   - Create helper module for `getUserMedia`, `getDisplayMedia`, Web Audio mixing, and `MediaRecorder`.
3. **Voice Recording Context (`desktop/src/context/VoiceRecordingContext.tsx`)**:
   - Wire client audio recorder to `start`, `pause`, `resume`, `stop`.
   - On `stop()`, send blob to `POST /api/voice/transcribe`.
4. **Listen Widget (`desktop/src/components/ListenWidget.tsx`)**:
   - Update audio source picker to list local client devices and sources.
5. **Widget Guard & Dialog (`desktop/src/components/NoteEditor.tsx` & `desktop/src/extensions/WidgetRemovalGuard.ts`)**:
   - Create `WidgetRemovalGuard` extension covering both `listen` and `whiteboard` nodes.
   - Render `WidgetRemovalDialog` for both node types and all states.
6. **Verification**:
   - Run `pytest backend/tests/test_voice.py`.
   - Run `npm run build` in `desktop`.

---

## 4. User-Driven Manual Testing Plan
1. **Widget Selection & Keypress Guard Test**:
   - Launch application via `start.cmd` or dev servers.
   - Open any note.
   - Insert a `whiteboard` widget (`/` -> Whiteboard).
   - Click on the whiteboard widget so the yellow border appears (`NodeSelection`).
   - Press a letter key (e.g. `x`) or `Backspace` or `Delete`.
   - **Verify**: The widget is NOT replaced. The modal dialog appears: *"Remove whiteboard widget? This whiteboard and any drawings in it will be deleted from the note. Do you want to proceed?"*
   - Press Escape or click "Keep Widget". **Verify**: The whiteboard widget remains intact and drawing is preserved.
   - Insert a `listen` widget (`/` -> Listen).
   - Select the listen widget (yellow border).
   - Press a letter key or `Backspace`.
   - **Verify**: The modal dialog appears asking for confirmation.
2. **Client Audio Recording Test (Local & Remote via Tailscale)**:
   - In the listen widget, select source: "Default microphone".
   - Click "Start Listening".
   - Allow browser microphone permission when prompted.
   - **Verify**: The title bar shows `🔴 Listening (00:0X)`, the widget pulses with recording clock, and browser tab shows active microphone indicator.
   - Speak a few sentences into the microphone (e.g. *"Discussing the deck layout for the yacht project"*).
   - Select the widget while recording and press a key.
   - **Verify**: Dialog appears: *"The widget is still listening. Removing or replacing it will interrupt the recording and all recording will be lost. Do you want to proceed?"*
   - Click "Keep Widget".
   - Click "Stop" on the widget or title bar indicator.
   - **Verify**: Status transitions to *"Transcribing..."*.
   - **Verify**: Once transcribed, the dialogue turns appear with speaker attribution, duration, and the audio player plays back your voice clearly.
