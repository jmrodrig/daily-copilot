# Implementation Plan: Phase 15 — System Tray Server Controller

## 1. Overview
The user needs a convenient, standalone method to manage the Daily Co-Pilot development servers (Backend FastAPI/Uvicorn on port 8000 and Frontend Desktop Vite on port 5173) without having to ask the assistant to start/stop/restart them every time.

We will implement **Option B**: A standalone Windows System Tray application (`scripts/copilot_tray.pyw`) paired with a double-clickable root launcher (`start_tray.cmd`).

---

## 2. Technical Specifications & Architecture

### A. Core Components
1. **Tray Controller Script**: `scripts/copilot_tray.pyw`
   - Written in Python using `pystray` (0.19.5), `PIL` (Pillow 12.3.0), `win32event` / `win32api`, and standard library modules (`subprocess`, `socket`, `threading`, `time`, `webbrowser`, `os`, `sys`, `pathlib`).
   - Extension `.pyw` ensures it launches under Windows `pythonw.exe` without keeping a console window open.
   - Robust single-instance lock using a Windows named mutex (`Local\DailyCopilotTrayMutex`) to prevent multiple instances running simultaneously.

2. **Launcher Script**: `start_tray.cmd` (at repository root)
   - Double-clickable Windows batch file:
     ```cmd
     @echo off
     start "" pythonw "%~dp0scripts\copilot_tray.pyw"
     ```
   - Can easily be pinned, placed on Desktop, or added to Windows Startup (`shell:startup`).

3. **Log Directory & Process Output**:
   - Log files written to `.logs/backend.log` and `.logs/desktop.log` in repository root.
   - Automatically creates `.logs/` directory if missing.
   - Logs are appended with timestamps.

4. **Dynamic System Tray Icon & Status Indicator**:
   - Generated dynamically with Pillow (`Image.new("RGBA", (64, 64))`, `ImageDraw.Draw`):
     - Dark rounded background square (`#101820`, matching app theme).
     - Central monogram / emblem and dynamic status indicator dot:
       - 🟢 **Online (Green `#22c55e`)**: Both Port 8000 (Backend) and Port 5173 (Desktop) are listening.
       - 🟡 **Transitioning / Partial (Yellow `#eab308`)**: One server is listening or an operation is in progress.
       - 🔴 **Stopped (Red `#ef4444`)**: Neither server is listening.
   - Background polling thread checks TCP connection on `127.0.0.1:8000` and `127.0.0.1:5173` every 2 seconds and updates icon and tooltip without blocking the tray loop.

5. **Process Lifecycle Management**:
   - **Backend Server**:
     - Command: `python -m uvicorn main:app --reload --port 8000` inside `backend/`.
     - Creation flags: `subprocess.CREATE_NO_WINDOW`.
   - **Desktop Vite Server**:
     - Command: `npm.cmd run dev -- --host 0.0.0.0` (or `cmd.exe /c npm run dev -- --host 0.0.0.0`) inside `desktop/`.
     - **CRITICAL**: The `--host 0.0.0.0` argument is strictly required so Vite binds to IPv4 (`127.0.0.1`), ensuring Tailscale Serve (`designer.tailf76a98.ts.net`) can route traffic without 502 Bad Gateway.
   - **Stopping & Cleanup**:
     - Uses `taskkill /F /T /PID <pid>` to terminate child process trees (e.g. node.exe, uvicorn reloaders).
     - Port recovery fallback: If ports 8000 or 5173 are still held by lingering processes, query netstat and terminate the holding PIDs.

6. **Tray Menu Structure**:
   - `Daily Co-Pilot: [Online | Partial | Stopped]` (Header / Status info)
   - `---`
   - `Start Servers`
   - `Stop Servers`
   - `Restart Servers`
   - `---`
   - `Open Web App (localhost:5173)` (opens `http://localhost:5173`)
   - `Open via Tailscale` (opens `https://designer.tailf76a98.ts.net`)
   - `---`
   - `View Backend Logs` (opens `.logs/backend.log` in default editor)
   - `View Desktop Logs` (opens `.logs/desktop.log` in default editor)
   - `---`
   - `Exit` (stops managed servers and exits tray app)

---

## 3. Files to Create / Modify
1. `scripts/copilot_tray.pyw` (NEW) — Full tray controller application.
2. `start_tray.cmd` (NEW) — Windows root launcher.
3. `.gitignore` (MODIFY) — Ensure `.logs/` is ignored by git.
4. `backend/tests/test_tray_controller.py` (NEW) — Unit tests covering socket port checking, status state transitions, icon generation, and single-instance mutex mechanics.

---

## 4. Manual, User-Driven Testing Plan (Enforced)
After automated QA passes and the servers are started:

1. **Launch Tray App**:
   - Double-click `start_tray.cmd` in the repository root (or run `pythonw scripts\copilot_tray.pyw`).
   - Check Windows System Tray (click `^` overflow chevron near the clock if hidden).
   - Verify a new Daily Co-Pilot icon appears. Hovering over it shows the tooltip: `Daily Co-Pilot: Online` (or `Stopped`).

2. **Test Menu Actions**:
   - Right-click the tray icon to open the context menu.
   - Click `Stop Servers`.
   - Observe the icon turn 🔴 Red, and tooltip update to `Daily Co-Pilot: Stopped`.
   - Open browser at `http://localhost:5173` and verify the page cannot connect.
   - Right-click the tray icon and click `Start Servers`.
   - Observe icon turn 🟡 Yellow (transitioning) and then 🟢 Green (online).
   - Click `Open Web App (localhost:5173)`. Verify default browser opens the Daily Co-Pilot interface.
   - Click `Open via Tailscale`. Verify browser opens `https://designer.tailf76a98.ts.net`.
   - Click `View Backend Logs` and `View Desktop Logs`. Verify Notepad or default text editor opens showing the server logs.

3. **Test Restart**:
   - Click `Restart Servers`. Verify status changes to yellow and back to green.

4. **Test Exit**:
   - Click `Exit`. Verify tray icon disappears and servers are cleanly terminated (or retained as desired).
