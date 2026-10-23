"""The system tray server controller (`scripts/copilot_tray.pyw`): port checks, status, icon, mutex, processes.

No real server is started: process launching and killing are stubbed out.
"""

import importlib.machinery
import importlib.util
import socket
import sys
import uuid
from pathlib import Path

import pytest

TRAY_PATH = Path(__file__).resolve().parents[2] / "scripts" / "copilot_tray.pyw"


def _load_tray():
    loader = importlib.machinery.SourceFileLoader("copilot_tray", str(TRAY_PATH))
    spec = importlib.util.spec_from_loader("copilot_tray", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


tray = _load_tray()


@pytest.fixture
def listening_port():
    """A port with a socket listening on 127.0.0.1."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    yield server.getsockname()[1]
    server.close()


@pytest.fixture
def free_port():
    """A port nothing listens on (bound then released)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


# --- Port checks ---------------------------------------------------------------------------------------------------


def test_is_port_open_when_listening(listening_port):
    assert tray.is_port_open(listening_port)


def test_is_port_open_when_free(free_port):
    assert not tray.is_port_open(free_port, timeout=0.2)


# --- Status --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("backend_up", "desktop_up", "busy", "expected"),
    [
        (True, True, False, tray.ONLINE),
        (True, False, False, tray.PARTIAL),
        (False, True, False, tray.PARTIAL),
        (False, False, False, tray.STOPPED),
        (False, False, True, tray.PARTIAL),
        (True, True, True, tray.PARTIAL),
    ],
)
def test_compute_status(backend_up, desktop_up, busy, expected):
    assert tray.compute_status(backend_up, desktop_up, busy) == expected


def test_status_title():
    assert tray.status_title(tray.ONLINE) == "Daily Co-Pilot: Online"
    assert tray.status_title(tray.PARTIAL) == "Daily Co-Pilot: Partial"
    assert tray.status_title(tray.STOPPED) == "Daily Co-Pilot: Stopped"


class FakeServer:
    def __init__(self, up=False):
        self.up = up
        self.started = 0
        self.stopped = []
        self.log_path = Path("unused.log")

    def is_up(self):
        return self.up

    def start(self):
        self.started += 1
        self.up = True

    def stop(self, managed_only=False):
        self.stopped.append(managed_only)
        self.up = False


@pytest.fixture
def no_waiting(monkeypatch):
    monkeypatch.setattr(tray, "START_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(tray, "STOP_TIMEOUT_SECONDS", 0)


def test_controller_status_transitions(no_waiting):
    backend, desktop = FakeServer(), FakeServer()
    controller = tray.ServerController([backend, desktop])
    assert controller.status() == tray.STOPPED

    backend.up = True
    assert controller.status() == tray.PARTIAL

    assert controller.start()
    assert (backend.started, desktop.started) == (1, 1)
    assert controller.status() == tray.ONLINE

    assert controller.stop()
    assert backend.stopped == [False] and desktop.stopped == [False]
    assert controller.status() == tray.STOPPED

    assert controller.restart()
    assert (backend.started, len(backend.stopped)) == (2, 2)
    assert controller.status() == tray.ONLINE
    assert not controller.busy


def test_controller_is_busy_during_an_operation(no_waiting):
    backend, desktop = FakeServer(up=True), FakeServer(up=True)
    controller = tray.ServerController([backend, desktop])
    seen = []

    def stop(managed_only=False):
        seen.append(controller.status())
        # A second operation while this one runs is refused.
        seen.append(controller.start())
        backend.up = False

    backend.stop = stop
    controller.stop()
    assert seen == [tray.PARTIAL, False]
    assert not controller.busy


def test_controller_exit_stops_only_managed_servers(no_waiting):
    backend, desktop = FakeServer(up=True), FakeServer(up=True)
    controller = tray.ServerController([backend, desktop])
    controller.stop(managed_only=True, wait=True)
    assert backend.stopped == [True] and desktop.stopped == [True]


# --- Icon ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("status", [tray.ONLINE, tray.PARTIAL, tray.STOPPED])
def test_icon_image(status):
    image = tray.create_icon_image(status)
    assert image.size == (64, 64)
    assert image.mode == "RGBA"
    # The status dot's center (bottom-right) carries the status color; the top-left corner of the square is the
    # dark background.
    hex_color = tray.STATUS_COLORS[status]
    expected = tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5)) + (255,)
    assert image.getpixel((48, 48)) == expected
    assert image.getpixel((14, 4)) == (0x10, 0x18, 0x20, 255)


def test_icon_images_differ_by_status():
    images = {status: tray.create_icon_image(status).tobytes() for status in tray.STATUS_COLORS}
    assert len(set(images.values())) == 3


# --- Single instance -----------------------------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="Windows named mutex")
def test_single_instance_mutex():
    name = f"Local\\DailyCopilotTrayTest-{uuid.uuid4()}"
    first = tray.SingleInstance(name)
    second = tray.SingleInstance(name)
    try:
        assert first.acquire()
        assert not second.acquire()
        assert second.handle is None
    finally:
        first.release()
    # Once released, the next tray can take it.
    with tray.SingleInstance(name) as acquired:
        assert acquired


# --- Processes -----------------------------------------------------------------------------------------------------

NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4321
  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       9876
  TCP    127.0.0.1:8000         127.0.0.1:51000        ESTABLISHED     9876
  TCP    127.0.0.1:51000        127.0.0.1:8000         ESTABLISHED     5555
  TCP    127.0.0.1:18000        0.0.0.0:0              LISTENING       7777
  TCP    [::]:5173              [::]:0                 LISTENING       4322
  TCP    127.0.0.1:8000         127.0.0.1:51001        TIME_WAIT       0
  UDP    0.0.0.0:8000           *:*                                    3333
"""


def test_parse_listening_pids():
    assert tray.parse_listening_pids(NETSTAT, 8000) == {9876}
    assert tray.parse_listening_pids(NETSTAT, 5173) == {4321, 4322}
    assert tray.parse_listening_pids(NETSTAT, 1234) == set()


def test_desktop_server_binds_all_interfaces():
    """Vite must bind IPv4 (`--host 0.0.0.0`) for Tailscale Serve."""
    backend, desktop = tray.default_servers()
    assert desktop.port == 5173 and desktop.command[-2:] == ["--host", "0.0.0.0"]
    assert backend.port == 8000 and backend.command[1:] == ["-m", "uvicorn", "main:app", "--reload", "--port", "8000"]
    assert backend.cwd == tray.BACKEND_DIR and desktop.cwd == tray.DESKTOP_DIR


class FakeProcess:
    pid = 4242
    stdout = None

    def poll(self):
        return None

    def wait(self, timeout=None):
        return 1


@pytest.fixture
def stubbed_processes(monkeypatch):
    calls = {"popen": [], "killed": []}

    def popen(command, **kwargs):
        calls["popen"].append((command, kwargs))
        return FakeProcess()

    monkeypatch.setattr(tray.subprocess, "Popen", popen)
    monkeypatch.setattr(tray.threading, "Thread", lambda **kwargs: type("T", (), {"start": lambda self: None})())
    monkeypatch.setattr(tray, "kill_tree", calls["killed"].append)
    monkeypatch.setattr(tray, "pids_on_port", lambda port: {1111} if port == 8000 else set())
    return calls


def test_managed_server_start_and_stop(stubbed_processes, tmp_path, free_port):
    log = tmp_path / ".logs" / "backend.log"
    server = tray.ManagedServer("backend", free_port, ["python", "-V"], tmp_path, log)

    assert server.start()
    command, kwargs = stubbed_processes["popen"][0]
    assert command == ["python", "-V"]
    assert kwargs["creationflags"] == tray.CREATE_NO_WINDOW
    assert kwargs["cwd"] == str(tmp_path)
    # Already managed: not started twice.
    assert not server.start()
    assert len(stubbed_processes["popen"]) == 1

    server.stop()
    assert stubbed_processes["killed"] == [4242]
    assert server.process is None
    text = log.read_text(encoding="utf-8")
    assert "backend: starting" in text and "backend: stopped" in text
    assert text.startswith("[")  # timestamped


def test_managed_server_skips_start_when_port_taken(stubbed_processes, tmp_path, listening_port):
    server = tray.ManagedServer("desktop", listening_port, ["npm"], tmp_path, tmp_path / "desktop.log")
    assert not server.start()
    assert stubbed_processes["popen"] == []


def test_stop_falls_back_to_port_holders(stubbed_processes, tmp_path):
    server = tray.ManagedServer("backend", 8000, ["python"], tmp_path, tmp_path / "backend.log")
    # Not started by the tray: Stop Servers still frees the port, Exit (managed_only) leaves it alone.
    server.stop(managed_only=True)
    assert stubbed_processes["killed"] == []
    server.stop()
    assert stubbed_processes["killed"] == [1111]


def test_python_executable_prefers_console_interpreter(monkeypatch, tmp_path):
    (tmp_path / "python.exe").write_text("")
    monkeypatch.setattr(tray.sys, "executable", str(tmp_path / "pythonw.exe"))
    assert tray.python_executable() == str(tmp_path / "python.exe")
