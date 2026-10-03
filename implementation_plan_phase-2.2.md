# Implementation Plan: Phase 2.2 - Capture UI and Backend Endpoint
**Task ID:** phase-2.2

## Goal
Build the Android Jetpack Compose UI for capturing quick ad hoc notes, and connect it to a new FastAPI backend endpoint that saves the notes directly into the Markdown file layer.

## Scope
### Backend (FastAPI)
- Add a new endpoint `POST /api/capture` in `backend/main.py`.
- It should accept a JSON payload (e.g., using a Pydantic schema):
  - `content`: string (the actual note text)
  - `project`: string (e.g., 'C7801', 'R5301', 'P5002', or 'Inbox')
  - `priority`: string (e.g., 'Low', 'Normal', 'High')
- The endpoint should construct a filename like `{project}/Notes-in/Capture_{timestamp}.md` (if project is not Inbox, otherwise `Inbox/Capture_{timestamp}.md`).
- It should use `file_layer.write_note(...)` to save the file. The frontmatter should include `type: "capture"`, `project`, and `priority`. The `source` should be `"android_app"` so the `history` table logs it correctly.
- Write tests using FastAPI's `TestClient` in `tests/test_api.py`.

### Android App
- **Networking**: Add OkHttp or Retrofit to `build.gradle.kts` to handle the POST request.
- **Config**: Allow setting the backend URL (e.g., `BACKEND_URL`) via `local.properties` so it gets injected into `BuildConfig.BACKEND_URL`. (Default to `http://10.0.2.2:8000` for emulator if not set).
- **UI**: Replace the placeholder in `MainActivity.kt` with a Jetpack Compose form:
  - A large multi-line `TextField` for the note `content`.
  - A project selector (Dropdown or segmented buttons: `C7801`, `R5301`, `P5002`, `Inbox`).
  - A priority selector (`Low`, `Normal`, `High`).
  - A `Button` to "Save".
- **State**: Show a loading indicator while saving, and a success `Snackbar` upon 200 OK, clearing the text field for the next note. Show an error `Snackbar` if it fails.

## Relevant Context
- The app must continue to use the dark-mode engineering theme (`shared/design-tokens.json`).
- Ensure the Android app handles network calls off the main thread (using Coroutines).
- Ensure `AndroidManifest.xml` has `<uses-permission android:name="android.permission.INTERNET" />` and allows cleartext traffic if needed for `http://` Tailscale endpoints.

## Files to Modify / Create
- `backend/main.py` (Add endpoint)
- `backend/schemas.py` (Add CaptureRequest schema)
- `backend/tests/test_api.py` (New)
- `android/app/build.gradle.kts` (Add networking deps, inject BuildConfig)
- `android/app/src/main/AndroidManifest.xml` (Add INTERNET permission)
- `android/app/src/main/java/com/bespoke/copilot/MainActivity.kt` (Build Compose UI)
- `android/app/src/main/java/com/bespoke/copilot/NetworkClient.kt` (New, simple API client)

## User-Driven Manual Test Plan
1. Ensure the API is running locally: `cd backend; uvicorn main:app --host 0.0.0.0 --port 8000`.
2. Add your Tailscale IP to `android/local.properties` (e.g., `BACKEND_URL="http://100.x.y.z:8000"`).
3. Build the Android app and install it on the phone (or emulator).
4. Type a note, select a project, and press Save.
5. Verify the app shows a success message and the markdown file appears in `C:\Users\designer\Documents\assistant\copilot\data\notes\{project}\Notes-in\`.
6. Verify the SQLite `history` table logged the creation!
