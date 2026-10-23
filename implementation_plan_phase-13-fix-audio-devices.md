# Implementation Plan — Phase 13-Fix: Audio Device Fallback via Sounddevice (WDM-KS)

## Problem & Root Cause Investigation

### The Error
When attempting to click "Start Listening" in the note's ListenWidget for either **Microphone** or **System audio (Teams / calls)**, the widget displays the error:
`"No audio device found for the system audio"` / `"No audio device found for the microphone"` (and `POST /api/voice/recording/start` returns HTTP 400 Bad Request).

### The Root Cause
1. `backend/voice.py` currently relies exclusively on `pyaudiowpatch` for device enumeration (`list_audio_devices()`) and stream recording (`DualStreamRecorder`).
2. On this Windows machine and environment, `pyaudiowpatch` queries PortAudio via MME, DirectSound, and WASAPI host APIs. All three report `deviceCount: 0` because PortAudio's WASAPI endpoint enumerator fails to discover endpoints in this terminal/session context.
3. However, `sounddevice` (which is already installed in Python 3.12) is built with PortAudio supporting `Windows WDM-KS` (Windows Driver Model — Kernel Streaming).
4. Running `sounddevice.query_devices()` on this machine directly detects all physical input and output hardware via kernel streaming:
   - Device 0: `FrontMic (Realtek HD Audio Front Mic input)` (2 in)
   - Device 1: `Speakers (Realtek HD Audio output)` (2 out)
   - Device 2: `Stereo Mix (Realtek HD Audio Stereo input)` (2 in) — **System Audio / Teams / Calls loopback!**
   - Device 3: `Microphone (Canyon CNS-CWC5 Microphone)` (1 in) — **Active primary microphone!**
   - Device 6: `Headset (MOMENTUM 4)` (1 in)
5. We have empirically verified via Python that `sounddevice.InputStream(..., callback=...)` captures audio flawlessly from both Device 3 (Canyon microphone) and Device 2 (Stereo Mix system audio) simultaneously.

---

## Required Changes

### 1. `backend/voice.py`

#### A. Multi-Backend Device Enumeration
Update `list_audio_devices()` and `_default_devices()`:
1. Attempt detection with `pyaudiowpatch` first.
2. If `pyaudiowpatch` returns 0 mics and 0 loopbacks (or raises an exception), seamlessly fallback to `sounddevice`:
   - Import `sounddevice as sd`.
   - Iterate over `sd.query_devices()`.
   - Separate devices into:
     - **mics**: `max_input_channels > 0` and not matched by loopback regex.
     - **loopbacks**: `max_input_channels > 0` and name contains `stereo mix`, `wave out mix`, `what u hear`, `loopback`, or `stereomix` (case-insensitive).
   - Determine `default_mic_index`:
     - Prefer `sd.default.device[0]` if valid, or the first input device with a known mic name (e.g. Canyon, FrontMic, Realtek), or the first mic in the list.
   - Determine `default_loopback_index`:
     - The first loopback device (e.g. Stereo Mix).
   - Format devices with `{index, name, host_api, channels, default_samplerate, backend: "sounddevice" | "pyaudio"}`.

#### B. Unified Dual-Backend Audio Capture in `DualStreamRecorder`
Update `DualStreamRecorder`:
1. Check which backend to use based on device index or availability:
   - If `pyaudiowpatch` has devices, use `pyaudiowpatch`.
   - If devices are from `sounddevice` (or if `pyaudiowpatch` is unavailable/empty), use `sounddevice.InputStream`:
     - **Important**: On Windows WDM-KS, `sounddevice` requires callback-based streams (`callback=_stream_callback`), not blocking `.read()`.
     - In the callback:
       ```python
       def _mic_callback(indata, frames, time_info, status):
           if self._recording and not self._paused and len(indata):
               # indata is float32 numpy array or int16
               self._mic_queue.put(indata.copy())
       ```
     - Convert audio arrays to int16 PCM before or during `resample_and_downmix`.
     - Manage stream lifecycle (`stream.start()`, `stream.stop()`, `stream.close()`).
     - Support single microphone (`source="mic"`), single system loopback (`source="loopback"`), and mixed recording (`source="mixed"`).
     - Handle start, pause, resume, stop, and clean writer thread shutdown.

### 2. `backend/requirements.txt`
Ensure `sounddevice>=0.4.6` is listed under the voice dependencies block.

### 3. `backend/tests/test_voice.py`
Add unit tests verifying:
1. Fallback to `sounddevice` when `pyaudiowpatch` returns 0 devices.
2. Device classification (mics vs loopbacks/stereo mix).
3. Recording session lifecycle with the fallback engine.

---

## Verification & User-Driven Testing Plan

### Automated QA
1. Run `pytest backend/tests/test_voice.py` -> verify all tests pass.
2. Run full test suite: `pytest backend/tests/` -> ensure 0 regressions.
3. Run `npm run build` in `desktop/` to verify frontend builds clean.

### Manual Hands-On Verification
1. Start backend server: `python -m uvicorn main:app --reload --port 8000`
2. Start desktop frontend: `npm run dev`
3. In the browser ([http://localhost:5173](http://localhost:5173)), navigate to a note with a `ListenWidget`.
4. Test **Default microphone**:
   - Select "Default microphone".
   - Click **Start Listening**.
   - Verify recording starts immediately without any "No audio device found" error.
   - Speak a few words, verify timer and audio bars animate.
   - Click **Stop** -> verify transcription produces dialogue text.
5. Test **System audio (Teams / calls)**:
   - Select "System audio (Teams / calls)".
   - Click **Start Listening**.
   - Verify recording starts immediately (using Stereo Mix).
   - Play a short sound/video on the computer.
   - Click **Stop** -> verify transcription captures the audio.
