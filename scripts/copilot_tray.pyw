"""Daily Co-Pilot system tray controller: start, stop and restart the dev servers from the Windows tray.

Launch with `start_tray.cmd` at the repository root (or `pythonw scripts\\copilot_tray.pyw`). It manages:

- the backend (FastAPI / uvicorn, port 8000): `python -m uvicorn main:app --reload --port 8000` in `backend/`;
- the desktop app (Vite, port 5173): `npm run dev -- --host 0.0.0.0` in `desktop/`. `--host 0.0.0.0` makes Vite
  bind IPv4 (`127.0.0.1`), which Tailscale Serve needs (without it, it answers 502 Bad Gateway).

Server output goes to `.logs/backend.log` and `.logs/desktop.log`, one timestamped line at a time. The icon's dot
shows the state, polled every 2 seconds: green when both ports listen, yellow when one does (or while starting or
stopping), red when neither does. A named mutex keeps a single tray running.
"""

import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
DESKTOP_DIR = REPO_ROOT / "desktop"
LOG_DIR = REPO_ROOT / ".logs"

HOST = "127.0.0.1"
BACKEND_PORT = 8000
DESKTOP_PORT = 5173
POLL_SECONDS = 2.0
START_TIMEOUT_SECONDS = 60.0
STOP_TIMEOUT_SECONDS = 15.0

WEB_APP_URL = f"http://localhost:{DESKTOP_PORT}"
TAILSCALE_URL = "https://designer.tailf76a98.ts.net"
MUTEX_NAME = "Local\\DailyCopilotTrayMutex"
APP_NAME = "Daily Co-Pilot"

ONLINE, PARTIAL, STOPPED = "online", "partial", "stopped"
STATUS_LABELS = {ONLINE: "Online", PARTIAL: "Partial", STOPPED: "Stopped"}
STATUS_COLORS = {ONLINE: "#22c55e", PARTIAL: "#eab308", STOPPED: "#ef4444"}
BACKGROUND_COLOR = "#101820"
MONOGRAM_COLOR = "#e2e8f0"

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


# --- Status --------------------------------------------------------------------------------------------------------


def is_port_open(port, host=HOST, timeout=0.5):
    """Whether something accepts TCP connections on host:port."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def compute_status(backend_up, desktop_up, busy=False):
    """The tray state: online when both servers listen, stopped when neither does (and nothing is in progress),
    partial otherwise (one server up, or a start / stop / restart running)."""
    if busy:
        return PARTIAL
    if backend_up and desktop_up:
        return ONLINE
    if backend_up or desktop_up:
        return PARTIAL
    return STOPPED


def status_title(status):
    """The tooltip and the menu header, e.g. `Daily Co-Pilot: Online`."""
    return f"{APP_NAME}: {STATUS_LABELS[status]}"


# --- Icon ----------------------------------------------------------------------------------------------------------


def create_icon_image(status, size=64):
    """The tray icon: a dark rounded square with a `C` monogram and a status dot in the bottom-right corner."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 5, fill=BACKGROUND_COLOR)
    # Monogram: an open ring (a "C") in the upper-left part of the square.
    ring = (size * 0.14, size * 0.14, size * 0.70, size * 0.70)
    draw.arc(ring, start=45, end=315, fill=MONOGRAM_COLOR, width=max(2, size // 9))
    # Status dot, outlined in the background color so it stands out from the monogram.
    dot = (size * 0.56, size * 0.56, size * 0.94, size * 0.94)
    draw.ellipse(dot, fill=STATUS_COLORS[status], outline=BACKGROUND_COLOR, width=max(1, size // 32))
    return image


# --- Single instance -----------------------------------------------------------------------------------------------


class SingleInstance:
    """A Windows named mutex held for the tray's lifetime; `acquire()` is False when another tray already holds it."""

    def __init__(self, name=MUTEX_NAME):
        self.name = name
        self.handle = None

    def acquire(self):
        import win32api
        import win32event
        import winerror

        handle = win32event.CreateMutex(None, False, self.name)
        if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
            win32api.CloseHandle(handle)
            return False
        self.handle = handle
        return True

    def release(self):
        if self.handle is not None:
            import win32api

            win32api.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()


# --- Processes -----------------------------------------------------------------------------------------------------


def parse_listening_pids(netstat_output, port):
    """The PIDs listening on `port` in `netstat -ano -p tcp` output (IPv4 and IPv6 lines)."""
    pids = set()
    for line in netstat_output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP" or parts[3].upper() != "LISTENING":
            continue
        if parts[1].rsplit(":", 1)[-1] != str(port):
            continue
        if parts[4].isdigit() and int(parts[4]) != 0:
            pids.add(int(parts[4]))
    return pids


def pids_on_port(port):
    """The PIDs holding `port` open, from netstat."""
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, creationflags=CREATE_NO_WINDOW, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    return parse_listening_pids(result.stdout, port)


def kill_tree(pid):
    """Force-kill a process and its children (uvicorn's reloader worker, node under npm)."""
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def python_executable():
    """The console interpreter next to this one: the tray runs under pythonw.exe, the backend wants python.exe."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        console = exe.with_name("python.exe")
        if console.exists():
            return str(console)
    return str(exe)


def timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log_line(log_path, text):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(f"[{timestamp()}] {text.rstrip()}\n")


def _pump_output(stream, log_path):
    """Copy a server's output into its log, one timestamped line at a time, until the process closes it."""
    try:
        for raw in iter(stream.readline, b""):
            log_line(log_path, raw.decode("utf-8", errors="replace"))
    except (OSError, ValueError):
        pass
    finally:
        stream.close()


class ManagedServer:
    """One dev server the tray starts and stops."""

    def __init__(self, name, port, command, cwd, log_path):
        self.name = name
        self.port = port
        self.command = command
        self.cwd = cwd
        self.log_path = log_path
        self.process = None

    def is_up(self):
        return is_port_open(self.port)

    def is_managed(self):
        return self.process is not None and self.process.poll() is None

    def start(self):
        """Start the server unless its port is already taken (by this tray or a server started elsewhere)."""
        if self.is_managed() or self.is_up():
            return False
        log_line(self.log_path, f"--- {self.name}: starting `{subprocess.list2cmdline(self.command)}` ---")
        self.process = subprocess.Popen(
            self.command,
            cwd=str(self.cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        threading.Thread(target=_pump_output, args=(self.process.stdout, self.log_path), daemon=True).start()
        return True

    def stop(self, managed_only=False):
        """Kill this tray's process tree, then (unless `managed_only` and the tray started nothing) whatever still
        holds the port: a lingering uvicorn worker or node, or a server started outside the tray."""
        was_managed = self.process is not None
        if self.process is not None:
            kill_tree(self.process.pid)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            self.process = None
        if was_managed or not managed_only:
            for pid in pids_on_port(self.port):
                kill_tree(pid)
            log_line(self.log_path, f"--- {self.name}: stopped ---")


def default_servers():
    return [
        ManagedServer(
            "backend",
            BACKEND_PORT,
            [python_executable(), "-m", "uvicorn", "main:app", "--reload", "--port", str(BACKEND_PORT)],
            BACKEND_DIR,
            LOG_DIR / "backend.log",
        ),
        ManagedServer(
            "desktop",
            DESKTOP_PORT,
            ["cmd.exe", "/c", "npm", "run", "dev", "--", "--host", "0.0.0.0"],
            DESKTOP_DIR,
            LOG_DIR / "desktop.log",
        ),
    ]


def wait_until(condition, timeout, interval=0.5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return condition()


class ServerController:
    """Starts, stops and restarts the dev servers; one operation at a time, flagged `busy` while it runs."""

    def __init__(self, servers=None):
        self.servers = servers if servers is not None else default_servers()
        self.busy = False
        self._lock = threading.Lock()

    def status(self):
        return compute_status(*(server.is_up() for server in self.servers[:2]), busy=self.busy)

    def _run(self, operation, wait=False):
        """Run `operation` unless another is in progress (or, with `wait`, once it finishes)."""
        if not self._lock.acquire(blocking=wait):
            return False
        self.busy = True
        try:
            operation()
        finally:
            self.busy = False
            self._lock.release()
        return True

    def _start(self):
        for server in self.servers:
            server.start()
        wait_until(lambda: all(server.is_up() for server in self.servers), START_TIMEOUT_SECONDS)

    def _stop(self, managed_only=False):
        for server in self.servers:
            server.stop(managed_only=managed_only)
        wait_until(lambda: not any(server.is_up() for server in self.servers), STOP_TIMEOUT_SECONDS)

    def start(self):
        return self._run(self._start)

    def stop(self, managed_only=False, wait=False):
        return self._run(lambda: self._stop(managed_only), wait=wait)

    def restart(self):
        def operation():
            self._stop()
            self._start()

        return self._run(operation)


# --- Tray ----------------------------------------------------------------------------------------------------------


def open_log(log_path):
    if not log_path.exists():
        log_line(log_path, "--- log created ---")
    os.startfile(str(log_path))


class TrayApp:
    def __init__(self, controller=None):
        import pystray

        self.pystray = pystray
        self.controller = controller or ServerController()
        self.status = None
        self._stop_event = threading.Event()
        self.icon = pystray.Icon("daily-copilot", create_icon_image(STOPPED), status_title(STOPPED), self._menu())

    def _menu(self):
        item, menu = self.pystray.MenuItem, self.pystray.Menu
        backend_log, desktop_log = (server.log_path for server in self.controller.servers[:2])
        return menu(
            item(lambda _: status_title(self.status or STOPPED), None, enabled=False),
            menu.SEPARATOR,
            item("Start Servers", self._in_background(self.controller.start)),
            item("Stop Servers", self._in_background(self.controller.stop)),
            item("Restart Servers", self._in_background(self.controller.restart)),
            menu.SEPARATOR,
            item(f"Open Web App (localhost:{DESKTOP_PORT})", lambda: webbrowser.open(WEB_APP_URL), default=True),
            item("Open via Tailscale", lambda: webbrowser.open(TAILSCALE_URL)),
            menu.SEPARATOR,
            item("View Backend Logs", lambda: open_log(backend_log)),
            item("View Desktop Logs", lambda: open_log(desktop_log)),
            menu.SEPARATOR,
            item("Exit", self._exit),
        )

    def _in_background(self, operation):
        """A menu action that runs `operation` off the tray thread and refreshes the icon right away."""

        def action():
            threading.Thread(target=operation, daemon=True).start()
            time.sleep(0.05)
            self.refresh()

        return action

    def refresh(self):
        status = self.controller.status()
        if status != self.status:
            self.status = status
            self.icon.icon = create_icon_image(status)
            self.icon.title = status_title(status)
            self.icon.update_menu()

    def _poll(self):
        while not self._stop_event.is_set():
            try:
                self.refresh()
            except Exception:  # noqa: BLE001 - a failed poll must not kill the status thread
                pass
            self._stop_event.wait(POLL_SECONDS)

    def _setup(self, icon):
        icon.visible = True
        threading.Thread(target=self._poll, daemon=True).start()

    def _exit(self):
        self._stop_event.set()
        self.icon.title = f"{APP_NAME}: stopping..."
        self.controller.stop(managed_only=True, wait=True)
        self.icon.stop()

    def run(self):
        self.icon.run(setup=self._setup)


def main():
    instance = SingleInstance()
    if not instance.acquire():
        return 0
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        TrayApp().run()
    finally:
        instance.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
