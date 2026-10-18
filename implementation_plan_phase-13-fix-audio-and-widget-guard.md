# Implementation Plan — Phase 13-Fix: Audio Capture Device Selection & Widget Deletion Guard

## 1. Problem & Root Cause Investigation

### Issue 1: Silence Captured ("No Speech Detected", 0:00 Audio Playback)
- **Root Cause**:
  - In `backend/voice.py`, `_sounddevice_defaults` picked `default_input = int(sd.default.device[0])`, which on this system evaluates to `0` (`FrontMic (Realtek HD Audio Front Mic input)`).
  - `FrontMic` is an unplugged front-panel chassis 3.5mm jack. Empirical testing confirms it records `RMS: 0.0` with `0` non-zero samples (pure digital zero silence).
  - The user's real, active microphone is Device 3: `Microphone (Canyon CNS-CWC5 Microphone)` (USB webcam microphone), which records with strong signal (`RMS: 0.047`, 45,000+ non-zero samples).
  - Furthermore, `desktop/src/components/ListenWidget.tsx` hardcoded the dropdown options to generic labels (`"Default microphone"`, `"System audio (Teams / calls)"`, `"Mixed"`) without querying or displaying the actual hardware devices returned by `GET /api/voice/devices`.

### Issue 2: Removing/Replacing Widget While Listening or After Transcribing
- **Requirement**:
  When the widget is selected in the note (or while in listening mode or after transcribing), do not allow removing or replacing the widget without a confirmation prompt warning that the widget is still listening (or contains recorded data), and that it will be interrupted and all recording lost if the user proceeds.
- **Root Cause**:
  - In TipTap (`NoteEditor.tsx`), when a block node is selected (NodeSelection), pressing Backspace, Delete, Cut, or typing/pasting immediately deletes the block without confirmation.
  - Clicking the widget's trash icon (`onRemove`) in `ListenNodeView` immediately executed `deleteNode()`.

---

## 2. Proposed Changes

### A. Backend (`backend/voice.py`, `backend/schemas.py`, `backend/main.py`)

1. **Intelligent Microphone Default in `_sounddevice_defaults`**:
   - Do NOT select unplugged chassis ports like `FrontMic` when a dedicated USB/webcam/headset microphone is available.
   - Filter `mics` prioritizing devices matching `canyon`, `usb`, `webcam`, `headset`, or starting with `Microphone` over `FrontMic`, `Line In`, or `Aux`.
   - On this machine, ensure Device 3 (`Microphone (Canyon CNS-CWC5 Microphone)`) is the primary default.
2. **Device-Specific Recording**:
   - Update `POST /api/voice/recording/start` request schema (`schemas.VoiceStartRequest`) and `voice.VoiceSession.start()`:
     - Accept optional `mic_index: int | None` and `loopback_index: int | None`.
     - When specified by the client, open that exact hardware index rather than falling back to default.
3. **Devices API**:
   - Ensure `GET /api/voice/devices` returns the complete list of devices with clean display names and indices.

### B. Desktop Frontend (`desktop/`)

1. **Dynamic Audio Source Selector in `ListenWidget.tsx`**:
   - Call `GET /api/voice/devices` on mount to fetch all available microphones and loopback devices.
   - Populate the source dropdown with actual hardware choices:
     - `Microphone (Canyon CNS-CWC5 Microphone) (Default)`
     - `FrontMic (Realtek HD Audio)`
     - `Headset (MOMENTUM 4)`
     - `System Audio: Stereo Mix (Teams / calls)`
     - `Mixed (Microphone + System Audio)`
   - Pass the chosen `mic_index` / `loopback_index` to `voice.start()`.
2. **Deletion & Replacement Guard in `ListenWidget.tsx` & `NoteEditor.tsx`**:
   - **Trash Icon Guard**:
     - When the trash button is clicked:
       - If `recording` or `processing`: show confirmation modal:
         > **"Voice recording is currently active"**  
         > *"The widget is still listening. Removing it will interrupt the recording and all recording will be lost. Do you want to proceed?"*  
         > Buttons: **Keep Widget** (Cancel), **Interrupt & Remove** (Stops recording, deletes node).
       - If `completed` (has dialogue/audio): show confirmation modal:
         > **"Remove recording widget?"**  
         > *"This note contains recorded meeting audio and transcript. Removing it will delete the recording from the note. Do you want to proceed?"*  
         > Buttons: **Keep Widget**, **Remove**.
   - **Editor Keyboard Selection Guard in `NoteEditor.tsx`**:
     - In TipTap `editorProps.handleKeyDown`:
       - Check if the current selection is a `NodeSelection` on a `listen` block.
       - If the user presses `Backspace`, `Delete`, `x` (with Ctrl/Cmd), or types any character while the `listen` node is selected:
         - If the widget is in listening mode (`is_recording` or `is_processing`) or has completed transcript data:
           - Prevent default event (`e.preventDefault()`).
           - Trigger the confirmation prompt dialog before allowing the node to be deleted or replaced!

---

## 3. Verification & User-Driven Testing Plan

### Automated Verification
1. Run `pytest backend/tests/test_voice.py` -> verify device selection and index passing.
2. Run full backend suite `pytest backend/tests/`.
3. Run `npm run build` in `desktop/`.

### Manual User-Driven Testing
1. Launch servers.
2. In the note with the `Listen` widget:
   - Verify the dropdown lists `Microphone (Canyon CNS-CWC5 Microphone)` as default.
   - Click **Start Listening** and speak for 5 seconds into the microphone.
   - Click **Stop**.
   - Listen to the audio playback -> verify speech is clearly audible!
   - Verify the transcript shows the spoken words instead of "no speech detected".
3. Test Guard:
   - While listening, select the widget block in the editor and press Backspace or click the trash button.
   - Verify the confirmation prompt appears warning that recording is active and will be lost.
   - Click "Keep Widget" -> verify recording continues uninterrupted.
