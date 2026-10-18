"""Voice notes (voice.py and /api/voice/*), with no audio device, Whisper model or ONNX session: the recorder, the
transcriber and the speaker embeddings are swapped for fakes."""

import json
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

import file_layer
import main
import voice


@pytest.fixture
def client(notes_dir, monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


class FakeRecorder:
    """Writes a second of silence where a recording would go."""

    def __init__(self, output_path: Path, mic_index, loopback_index):
        self.output_path = output_path
        self.devices = (mic_index, loopback_index)
        self.is_paused = False

    def start(self):
        voice.save_wav(np.zeros(voice.TARGET_RATE, dtype=np.float32), voice.TARGET_RATE, self.output_path)

    def pause(self):
        self.is_paused = True

    def resume(self):
        self.is_paused = False

    def duration(self):
        return 1.5

    def stop(self):
        return self.output_path


FAKE_RESULT = {
    "duration": 48.5,
    "participants": [
        {"speaker_id": "Participant 1", "display_name": "Alice", "is_tagged": True, "email": "alice@spirityachts.com", "cluster_id": 1},
        {"speaker_id": "Participant 2", "display_name": "Participant 2", "is_tagged": False, "cluster_id": 2, "audio_stem": "x", "sample_text": "Frame 12."},
    ],
    "dialogue": "[00:00 - 00:15] **Alice:** Hello.\n\n[00:16 - 00:30] **Participant 2:** Let's review `frame 12`.",
    "full_text": "Hello. Let's review `frame 12`.",
}


@pytest.fixture
def session(monkeypatch):
    """A fresh recording session, recording with FakeRecorder from the devices asked for (or 0, 9 by default)."""
    fresh = voice.VoiceSession()
    fresh.recorder_factory = FakeRecorder
    monkeypatch.setattr(voice, "SESSION", fresh)
    monkeypatch.setattr(
        voice,
        "source_devices",
        lambda source, mic, loop: (
            (0 if mic is None else mic) if source in ("mic", "mixed") else None,
            (9 if loop is None else loop) if source in ("loopback", "mixed") else None,
        ),
    )

    def fake_transcribe(path, progress=None):
        if progress:
            progress("Transcribing with Whisper...")
        return {**FAKE_RESULT, "audio_file": path.name, "audio_url": voice.audio_url(path.name)}

    monkeypatch.setattr(voice, "transcribe_audio", fake_transcribe)
    return fresh


def write_note(notes_dir: Path, path: str, body: str) -> None:
    file_layer.write_note(path, body, {"title": "Meeting", "state": "draft"}, "write_directly", notes_dir=notes_dir)


IDLE_BLOCK = '```listen\n{"id":"lw_abc","status":"idle","source":"mic"}\n```'


# --- Devices ------------------------------------------------------------------------------------------------------


class FakePyAudio:
    DEVICES = [
        {"index": 0, "name": "Microphone (USB)", "maxInputChannels": 1, "defaultSampleRate": 48000, "hostApi": 0},
        {"index": 1, "name": "Speakers (Realtek)", "maxInputChannels": 0, "defaultSampleRate": 48000, "hostApi": 0},
        {"index": 2, "name": "Speakers (Realtek) [Loopback]", "maxInputChannels": 2, "defaultSampleRate": 48000, "hostApi": 1, "isLoopbackDevice": True},
    ]

    def get_device_count(self):
        return len(self.DEVICES)

    def get_device_info_by_index(self, i):
        return self.DEVICES[i]

    def get_host_api_info_by_index(self, i):
        return {"name": ["MME", "Windows WASAPI"][i]}

    def get_host_api_info_by_type(self, _type):
        return {"index": 1}

    def get_loopback_device_info_generator(self):
        return (d for d in self.DEVICES if d.get("isLoopbackDevice"))

    def get_default_input_device_info(self):
        return self.DEVICES[0]

    def terminate(self):
        pass


def test_list_audio_devices_splits_mics_and_loopbacks(monkeypatch):
    monkeypatch.setattr(voice, "_pyaudio", lambda: SimpleNamespace(PyAudio=FakePyAudio, paWASAPI=13))

    devices = voice.list_audio_devices()

    assert [d["name"] for d in devices["mics"]] == ["Microphone (USB)"]  # an output-only device isn't listed
    assert [d["name"] for d in devices["loopbacks"]] == ["Speakers (Realtek) [Loopback]"]
    assert devices["loopbacks"][0]["host_api"] == "Windows WASAPI"
    assert devices["default_mic_index"] == 0
    assert devices["default_loopback_index"] == 2


def test_devices_endpoint(client, monkeypatch):
    monkeypatch.setattr(voice, "_pyaudio", lambda: SimpleNamespace(PyAudio=FakePyAudio, paWASAPI=13))
    response = client.get("/api/voice/devices")
    assert response.status_code == 200
    assert response.json()["default_loopback_index"] == 2


def test_devices_endpoint_without_pyaudio_or_sounddevice_is_503(client, monkeypatch):
    def missing():
        raise voice.VoiceError("Audio capture needs a library")

    monkeypatch.setattr(voice, "_pyaudio", missing)
    monkeypatch.setattr(voice, "_sounddevice", missing)
    response = client.get("/api/voice/devices")
    assert response.status_code == 503
    assert "pyaudiowpatch or sounddevice" in response.json()["detail"]


class EmptyPyAudio(FakePyAudio):
    """PortAudio's MME, DirectSound and WASAPI finding nothing."""

    DEVICES = []

    def get_default_input_device_info(self):
        raise OSError("No Default Input Device Available")


class FakeInputStream:
    """A sounddevice callback stream: `feed` plays as the device delivering a buffer."""

    opened: list["FakeInputStream"] = []

    def __init__(self, device, channels, samplerate, dtype, blocksize, callback):
        self.device, self.channels, self.samplerate, self.dtype = device, channels, samplerate, dtype
        self.callback = callback
        self.started = self.closed = False
        FakeInputStream.opened.append(self)

    def feed(self, samples: np.ndarray):
        self.callback(samples.astype(np.float32).reshape(-1, self.channels), len(samples), None, None)

    def start(self):
        self.started = True

    def stop(self):
        self.started = False

    def close(self):
        self.closed = True


class FakeSoundDevice:
    """sounddevice as it is on a machine where only WDM-KS finds the hardware."""

    DEVICES = [
        {"index": 0, "name": "FrontMic (Realtek HD Audio Front Mic input)", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 0, "default_samplerate": 44100.0},
        {"index": 1, "name": "Speakers (Realtek HD Audio output)", "hostapi": 0, "max_input_channels": 0, "max_output_channels": 2, "default_samplerate": 44100.0},
        {"index": 2, "name": "Stereo Mix (Realtek HD Audio Stereo input)", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 0, "default_samplerate": 48000.0},
        {"index": 3, "name": "Microphone (Canyon CNS-CWC5 Microphone)", "hostapi": 0, "max_input_channels": 1, "max_output_channels": 0, "default_samplerate": 16000.0},
    ]
    default = SimpleNamespace(device=[-1, 1])  # no default input
    InputStream = FakeInputStream

    @classmethod
    def query_devices(cls, index=None):
        return cls.DEVICES if index is None else cls.DEVICES[index]

    @staticmethod
    def query_hostapis(index):
        return {"name": "Windows WDM-KS"}


@pytest.fixture
def wdm_ks_only(monkeypatch):
    """pyaudiowpatch finds no device; sounddevice (WDM-KS) finds them all."""
    FakeInputStream.opened = []
    monkeypatch.setattr(voice, "_pyaudio", lambda: SimpleNamespace(PyAudio=EmptyPyAudio, paWASAPI=13))
    monkeypatch.setattr(voice, "_sounddevice", lambda: FakeSoundDevice)


def test_devices_fall_back_to_sounddevice_when_pyaudio_finds_none(wdm_ks_only):
    devices = voice.list_audio_devices()

    assert devices["backend"] == "sounddevice"
    # Stereo Mix records the system audio; an output-only device isn't listed.
    assert [d["name"] for d in devices["loopbacks"]] == ["Stereo Mix (Realtek HD Audio Stereo input)"]
    assert [d["index"] for d in devices["mics"]] == [0, 3]
    assert devices["mics"][1] == {
        "index": 3,
        "name": "Microphone (Canyon CNS-CWC5 Microphone)",
        "host_api": "Windows WDM-KS",
        "channels": 1,
        "default_samplerate": 16000,
        "backend": "sounddevice",
    }
    # No default input set: the one named a microphone.
    assert devices["default_mic_index"] == 3
    assert devices["default_loopback_index"] == 2


def test_sounddevice_default_skips_an_unplugged_front_mic_for_a_usb_one(wdm_ks_only, monkeypatch):
    # The system's default input is the chassis FrontMic (silent with nothing plugged in): the Canyon mic wins.
    monkeypatch.setattr(FakeSoundDevice, "default", SimpleNamespace(device=[0, 1]))
    assert voice.list_audio_devices()["default_mic_index"] == 3


def test_sounddevice_default_input_breaks_ties(wdm_ks_only, monkeypatch):
    usb = {"index": 4, "name": "Microphone (USB Audio Device)", "hostapi": 0, "max_input_channels": 1, "default_samplerate": 48000.0}
    monkeypatch.setattr(FakeSoundDevice, "DEVICES", [*FakeSoundDevice.DEVICES, usb])
    monkeypatch.setattr(FakeSoundDevice, "default", SimpleNamespace(device=[4, 1]))
    assert voice.list_audio_devices()["default_mic_index"] == 4


def test_sounddevice_front_mic_is_the_default_when_alone(wdm_ks_only, monkeypatch):
    monkeypatch.setattr(FakeSoundDevice, "DEVICES", FakeSoundDevice.DEVICES[:3])
    assert voice.list_audio_devices()["default_mic_index"] == 0


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("Headset (@System32\\drivers\\bthhfenum.sys,#2;%1 Hands-Free%0\n;(MOMENTUM 4))", "Headset (MOMENTUM 4)"),
        ("Microphone (Canyon CNS-CWC5 Microphone)", "Microphone (Canyon CNS-CWC5 Microphone)"),
        ("Stereo Mix\n(Realtek)", "Stereo Mix (Realtek)"),
    ],
)
def test_device_names_are_cleaned(raw, clean):
    assert voice._clean_device_name(raw) == clean


@pytest.mark.parametrize(
    ("names", "expected"),
    [
        (["FrontMic (Realtek)", "Microphone (Canyon CNS-CWC5 Microphone)"], 1),
        (["Line In (Realtek)", "Headset (MOMENTUM 4)"], 1),
        (["Aux (Realtek)", "Microphone (Realtek)"], 1),
        (["Headset (MOMENTUM 4)", "Microphone (USB Webcam)"], 1),
        (["FrontMic (Realtek)", "Line In (Realtek)"], 0),
    ],
)
def test_preferred_mic_ranks_dedicated_mics_over_chassis_jacks(names, expected):
    mics = [{"index": i, "name": name} for i, name in enumerate(names)]
    assert voice._preferred_mic(mics, None) == expected
    assert voice._preferred_mic([], 0) is None


@pytest.mark.parametrize("name", ["Wave Out Mix", "What U Hear (Sound Blaster)", "Loopback (VB-Audio)", "StereoMix"])
def test_sounddevice_loopbacks_are_told_by_name(wdm_ks_only, monkeypatch, name):
    device = {"index": 0, "name": name, "hostapi": 0, "max_input_channels": 2, "default_samplerate": 48000.0}
    monkeypatch.setattr(FakeSoundDevice, "DEVICES", [device])

    devices = voice.list_audio_devices()

    assert devices["mics"] == [] and devices["default_mic_index"] is None
    assert [d["name"] for d in devices["loopbacks"]] == [name]


def test_devices_fall_back_to_sounddevice_without_pyaudio(wdm_ks_only, monkeypatch):
    def missing():
        raise voice.VoiceError("Audio capture needs pyaudiowpatch")

    monkeypatch.setattr(voice, "_pyaudio", missing)
    assert voice.list_audio_devices()["backend"] == "sounddevice"


def test_pyaudio_devices_are_kept_when_it_finds_some(monkeypatch):
    monkeypatch.setattr(voice, "_pyaudio", lambda: SimpleNamespace(PyAudio=FakePyAudio, paWASAPI=13))
    monkeypatch.setattr(voice, "_sounddevice", lambda: pytest.fail("sounddevice isn't needed"))
    assert voice.list_audio_devices()["backend"] == "pyaudio"


def test_source_devices_defaults_come_from_the_fallback(wdm_ks_only):
    assert voice.source_devices("mic", None, None) == (3, None)
    assert voice.source_devices("loopback", None, None) == (None, 2)
    assert voice.source_devices("mixed", 0, None) == (0, 2)


def test_sounddevice_recording_lifecycle(wdm_ks_only, tmp_path):
    output = tmp_path / "rec.wav"
    recorder = voice.DualStreamRecorder(output, 3, 2)
    recorder.start()

    assert recorder.backend == "sounddevice"
    mic, loop = FakeInputStream.opened
    assert (mic.device, mic.channels, mic.samplerate, mic.dtype) == (3, 1, 16000, "float32")
    assert (loop.device, loop.channels, loop.samplerate) == (2, 2, 48000)
    assert mic.started and loop.started

    mic.feed(np.full(1600, 0.5))  # 0.1 s at 16 kHz
    loop.feed(np.full(4800 * 2, 0.25))  # 0.1 s of stereo at 48 kHz
    recorder.pause()
    mic.feed(np.full(16000, 0.5))  # not recorded
    assert recorder.is_paused
    recorder.resume()
    mic.feed(np.full(1600, -0.5))

    assert recorder.stop() == output
    assert mic.closed and loop.closed and not mic.started
    with wave.open(str(output)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, voice.TARGET_RATE)
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    assert 3200 <= len(samples) <= 3200 + 1600  # the paused second left out
    assert samples.max() > 0 and samples.min() < 0


def test_sounddevice_recording_without_any_device_opening_fails(wdm_ks_only, tmp_path, monkeypatch):
    def broken(self):
        raise RuntimeError("Error opening InputStream")

    monkeypatch.setattr(FakeInputStream, "start", broken)
    recorder = voice.DualStreamRecorder(tmp_path / "rec.wav", 3, None, backend="sounddevice")

    with pytest.raises(voice.VoiceError, match="Error opening InputStream"):
        recorder.start()
    assert FakeInputStream.opened[0].closed
    assert recorder.duration() == 0.0


# --- The single recording -----------------------------------------------------------------------------------------


def test_second_start_is_refused_while_recording(client, session):
    first = client.post("/api/voice/recording/start", json={"source": "mic", "widget_id": "lw_one", "note_path": "a.md"})
    assert first.status_code == 200
    assert first.json()["is_recording"] is True
    assert first.json()["widget_id"] == "lw_one"

    second = client.post("/api/voice/recording/start", json={"source": "mic", "widget_id": "lw_two"})
    assert second.status_code == 409

    status = client.get("/api/voice/recording/status").json()
    assert status["widget_id"] == "lw_one"
    assert status["note_path"] == "a.md"
    assert status["source"] == "mic"
    assert status["elapsed_seconds"] == 1.5


def test_start_records_from_the_source_devices(client, session):
    client.post("/api/voice/recording/start", json={"source": "mixed", "widget_id": "lw_one", "mic_device_index": 3})
    assert session._recorder.devices == (3, 9)


def test_start_takes_the_short_device_index_names(client, session):
    body = {"source": "mixed", "widget_id": "lw_one", "mic_index": 5, "loopback_index": 7}
    assert client.post("/api/voice/recording/start", json=body).status_code == 200
    assert session._recorder.devices == (5, 7)


def test_start_is_refused_while_the_last_recording_is_transcribed(client, session):
    client.post("/api/voice/recording/start", json={"widget_id": "lw_one"})
    session.stop()  # stopped, not finished: still processing

    response = client.post("/api/voice/recording/start", json={"widget_id": "lw_two"})
    assert response.status_code == 409
    assert "transcribed" in response.json()["detail"]
    assert client.get("/api/voice/recording/status").json()["is_processing"] is True


def test_pause_and_resume(client, session):
    assert client.post("/api/voice/recording/pause").status_code == 409  # nothing to pause
    client.post("/api/voice/recording/start", json={"widget_id": "lw_one"})

    assert client.post("/api/voice/recording/pause").json()["is_paused"] is True
    assert client.post("/api/voice/recording/resume").json()["is_paused"] is False


def test_start_with_an_unknown_space_is_404(client, session):
    response = client.post("/api/voice/recording/start", json={"widget_id": "lw_one", "space_id": 999})
    assert response.status_code == 404
    assert client.get("/api/voice/recording/status").json()["is_recording"] is False


def test_bad_widget_id_is_refused(client, session):
    response = client.post("/api/voice/recording/start", json={"widget_id": "../evil"})
    assert response.status_code == 422


def test_stop_without_a_recording_is_409(client, session):
    assert client.post("/api/voice/recording/stop").status_code == 409


def test_stop_transcribes_and_writes_the_result_into_the_note(client, session, notes_dir):
    write_note(notes_dir, "Meetings/Review.md", f"# Review\n\n{IDLE_BLOCK}\n\nAfter the widget.\n")
    client.post("/api/voice/recording/start", json={"source": "mic", "widget_id": "lw_abc", "note_path": "Meetings/Review.md"})

    response = client.post("/api/voice/recording/stop")

    assert response.status_code == 200
    result = response.json()
    assert result["id"] == "lw_abc"
    assert result["status"] == "completed"
    assert result["note_updated"] is True
    assert result["audio_url"] == f"/api/voice/audio/{result['audio_file']}"
    assert result["participants"][0]["display_name"] == "Alice"

    content = file_layer.read_note("Meetings/Review.md", notes_dir=notes_dir)["content"]
    assert content.startswith("# Review\n\n```listen\n")
    assert content.endswith("\n```\n\nAfter the widget.\n")
    match = voice.LISTEN_FENCE.search(content)
    block = json.loads(match.group(1))
    assert block["dialogue"] == FAKE_RESULT["dialogue"]
    assert "`" not in match.group(1)  # escaped, so the fence can't end early

    # Free again for the next recording.
    status = client.get("/api/voice/recording/status").json()
    assert status["is_recording"] is False and status["is_processing"] is False
    assert client.post("/api/voice/recording/start", json={"widget_id": "lw_next"}).status_code == 200


def test_stop_without_the_block_in_the_note_still_returns_the_result(client, session, notes_dir):
    write_note(notes_dir, "Other.md", "No widget here.")
    client.post("/api/voice/recording/start", json={"widget_id": "lw_gone", "note_path": "Other.md"})

    result = client.post("/api/voice/recording/stop").json()

    assert result["note_updated"] is False
    assert result["dialogue"] == FAKE_RESULT["dialogue"]
    assert file_layer.read_note("Other.md", notes_dir=notes_dir)["content"] == "No widget here."


def test_failed_transcription_frees_the_session(client, session, monkeypatch):
    def broken(path, progress=None):
        raise RuntimeError("model download failed")

    monkeypatch.setattr(voice, "transcribe_audio", broken)
    client.post("/api/voice/recording/start", json={"widget_id": "lw_one"})

    response = client.post("/api/voice/recording/stop")

    assert response.status_code == 500
    assert "model download failed" in response.json()["detail"]
    assert client.get("/api/voice/recording/status").json()["is_processing"] is False


# --- Uploads and audio files --------------------------------------------------------------------------------------


def test_transcribe_upload_makes_a_voice_note_in_the_inbox(client, session, notes_dir):
    response = client.post("/api/voice/transcribe", files={"file": ("phone.m4a", b"fake audio", "audio/mp4")})

    assert response.status_code == 200
    result = response.json()
    assert result["source"] == "upload"
    assert result["audio_file"].endswith(".m4a")
    path = result["note_path"]
    assert path.startswith("Inbox/Voice_") and path.endswith(".md")
    note = file_layer.read_note(path, notes_dir=notes_dir)
    assert note["frontmatter"]["source"] == "voice"
    assert note["frontmatter"]["type"] == "capture"
    assert json.loads(voice.LISTEN_FENCE.search(note["content"]).group(1))["id"] == result["id"]


def test_transcribe_upload_appends_to_a_note(client, session, notes_dir):
    write_note(notes_dir, "Call.md", "Notes from the call.")
    response = client.post(
        "/api/voice/transcribe", data={"note_path": "Call.md"}, files={"file": ("call.wav", b"RIFF", "audio/wav")}
    )
    assert response.status_code == 200
    content = file_layer.read_note("Call.md", notes_dir=notes_dir)["content"]
    assert content.startswith("Notes from the call.\n\n```listen\n")


def test_transcribe_upload_updates_existing_widget_block(client, session, notes_dir):
    write_note(notes_dir, "Meetings/Review.md", f"# Review\n\n{IDLE_BLOCK}\n\nAfter the widget.\n")

    response = client.post(
        "/api/voice/transcribe",
        data={"note_path": "Meetings/Review.md", "widget_id": "lw_abc", "source": "mixed"},
        files={"file": ("recording.webm", b"fake webm", "audio/webm")},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["id"] == "lw_abc"
    assert result["source"] == "mixed"
    assert result["status"] == "completed"
    assert result["note_updated"] is True
    assert result["note_path"] == "Meetings/Review.md"
    assert result["audio_file"].endswith(".webm")

    # Written into the widget's own block, in place: no second block appended.
    content = file_layer.read_note("Meetings/Review.md", notes_dir=notes_dir)["content"]
    assert content.startswith("# Review\n\n```listen\n")
    assert content.endswith("\n```\n\nAfter the widget.\n")
    assert content.count("```listen") == 1
    block = json.loads(voice.LISTEN_FENCE.search(content).group(1))
    assert block["id"] == "lw_abc"
    assert block["status"] == "completed"
    assert block["dialogue"] == FAKE_RESULT["dialogue"]


def test_transcribe_upload_for_a_widget_gone_from_its_note_still_returns_the_result(client, session, notes_dir):
    write_note(notes_dir, "Other.md", "No widget here.")

    response = client.post(
        "/api/voice/transcribe",
        data={"note_path": "Other.md", "widget_id": "lw_gone"},
        files={"file": ("recording.webm", b"fake webm", "audio/webm")},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["id"] == "lw_gone"
    assert result["source"] == "mic"
    assert result["note_updated"] is False
    assert file_layer.read_note("Other.md", notes_dir=notes_dir)["content"] == "No widget here."


def test_transcribe_upload_refuses_other_files_and_missing_notes(client, session):
    assert client.post("/api/voice/transcribe", files={"file": ("notes.exe", b"MZ")}).status_code == 400
    missing = client.post("/api/voice/transcribe", data={"note_path": "Nope.md"}, files={"file": ("a.wav", b"RIFF")})
    assert missing.status_code == 404


def test_audio_files_are_served_from_their_folders_only(client):
    recording = voice.recordings_dir() / "voice_20261018_130000.wav"
    voice.save_wav(np.zeros(160, dtype=np.float32), 16000, recording)

    ok = client.get("/api/voice/audio/voice_20261018_130000.wav")
    assert ok.status_code == 200
    assert ok.headers["content-type"] == "audio/wav"
    assert client.get("/api/voice/audio/missing.wav").status_code == 404
    assert client.get("/api/voice/audio/..%5Csecret.wav").status_code == 400
    assert client.get("/api/voice/snippets/voice_20261018_130000.wav").status_code == 404  # not a snippet


# --- Transcription, diarization and voiceprints -------------------------------------------------------------------


def unit(*values: float) -> np.ndarray:
    vector = np.zeros(512, dtype=np.float32)
    vector[: len(values)] = values
    return voice.normalize(vector)


ALICE = unit(1, 0.05)
BOB = unit(0.05, 1)


def test_cluster_speakers_numbers_them_in_speaking_order():
    assert voice.cluster_speakers([]) == []
    assert voice.cluster_speakers([BOB]) == [1]
    assert voice.cluster_speakers([BOB, BOB, ALICE, BOB, ALICE]) == [1, 1, 2, 1, 2]
    # Close embeddings are one speaker.
    assert voice.cluster_speakers([ALICE, unit(1, 0.1), unit(1, 0.0)]) == [1, 1, 1]


def test_identify_speaker_matches_enrolled_voiceprints_over_the_threshold():
    assert voice.identify_speaker(ALICE) is None  # nobody enrolled yet
    voice.save_contact("Alice", email="alice@spirityachts.com", embedding=ALICE)

    match = voice.identify_speaker(unit(1, 0.1))
    assert match["name"] == "Alice"
    assert match["email"] == "alice@spirityachts.com"
    assert match["similarity"] > voice.MATCH_THRESHOLD
    assert voice.identify_speaker(BOB) is None


def test_save_contact_blends_a_new_sample_into_the_voiceprint():
    voice.save_contact("Alice", embedding=ALICE)
    contact = voice.save_contact("alice", embedding=BOB)  # same person, another case

    assert contact["sample_count"] == 2
    stored = np.load(voice.voiceprints_dir() / "alice.npy")
    assert np.dot(stored, ALICE) > np.dot(stored, BOB)  # 60% old, 40% new
    assert [c["name"] for c in voice.list_contacts()] == ["alice"]
    assert voice.list_contacts()[0]["has_voiceprint"] is True


def fake_audio(monkeypatch, embeddings_by_start: dict[float, np.ndarray]) -> Path:
    """A 30 s recording whose segments (keyed by their start) embed as given."""
    monkeypatch.setattr(voice, "load_audio", lambda path: (np.zeros(30 * 16000, dtype=np.float32), 16000))
    starts = sorted(embeddings_by_start)

    def embed(chunk, sr):
        # Segments are cut in order, so the n-th call is the n-th segment.
        embed.calls += 1
        return embeddings_by_start[starts[embed.calls - 1]]

    embed.calls = 0
    monkeypatch.setattr(voice, "extract_speaker_embedding", embed)
    return voice.recordings_dir() / "voice_20261018_130000.wav"


SEGMENTS = [
    {"start": 0.0, "end": 3.0, "text": "Hello everyone."},
    {"start": 3.5, "end": 6.0, "text": "Let's start."},
    {"start": 7.0, "end": 10.0, "text": "Let's review the frame 12 calculations."},
    {"start": 20.0, "end": 22.0, "text": "Agreed."},
]


def test_diarize_names_known_speakers_and_snips_unknown_ones(monkeypatch):
    voice.save_contact("Alice", email="alice@spirityachts.com", embedding=ALICE)
    path = fake_audio(monkeypatch, {0.0: ALICE, 3.5: ALICE, 7.0: BOB, 20.0: ALICE})

    speakers, participants = voice.diarize_segments(SEGMENTS, path)

    assert speakers == ["Alice", "Alice", "Participant 2", "Alice"]
    alice, unknown = participants
    assert alice["is_tagged"] is True and alice["display_name"] == "Alice" and alice["snippet_url"] is None
    assert unknown["is_tagged"] is False
    assert unknown["sample_text"] == "Let's review the frame 12 calculations."
    assert unknown["snippet_url"] == "/api/voice/snippets/voice_20261018_130000_participant_2.wav"
    with wave.open(str(voice.snippets_dir() / "voice_20261018_130000_participant_2.wav")) as snippet:
        assert snippet.getnframes() == 3 * 16000
    # Each speaker's embedding is kept for tagging them later.
    assert (voice.embeddings_dir() / "voice_20261018_130000_2.npy").exists()


def test_diarize_without_readable_audio_is_one_speaker(monkeypatch):
    def unreadable(path):
        raise OSError("bad file")

    monkeypatch.setattr(voice, "load_audio", unreadable)
    speakers, participants = voice.diarize_segments(SEGMENTS, Path("x.wav"))
    assert speakers == ["Participant 1"] * 4
    assert len(participants) == 1 and participants[0]["is_tagged"] is False


def test_build_dialogue_groups_turns_and_splits_on_long_pauses():
    dialogue = voice.build_dialogue(SEGMENTS, ["Alice", "Alice", "Participant 2", "Participant 2"])
    assert dialogue.split("\n\n") == [
        "[00:00 - 00:06] **Alice:** Hello everyone. Let's start.",
        "[00:07 - 00:10] **Participant 2:** Let's review the frame 12 calculations.",
        "[00:20 - 00:22] **Participant 2:** Agreed.",
    ]


def test_transcribe_audio_pipeline(monkeypatch):
    path = voice.recordings_dir() / "voice_20261018_130000.wav"
    voice.save_wav(np.zeros(16000, dtype=np.float32), 16000, path)
    seen = {}

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            seen.update(kwargs)
            segments = [SimpleNamespace(start=s["start"], end=s["end"], text=f" {s['text']} ") for s in SEGMENTS[:3]]
            return iter(segments), SimpleNamespace(duration=10.0)

    monkeypatch.setattr(voice, "get_whisper_model", lambda name=None: FakeModel())
    monkeypatch.setattr(
        voice,
        "diarize_segments",
        lambda segments, p: (["Participant 1", "Participant 1", "Participant 2"], [{"speaker_id": "Participant 1"}, {"speaker_id": "Participant 2"}]),
    )
    stages = []

    result = voice.transcribe_audio(path, progress=stages.append)

    assert seen["vad_filter"] is True
    assert seen["vad_parameters"] == {"min_silence_duration_ms": 500}
    assert seen["language"] == "en"
    assert result["duration"] == 10.0
    assert result["full_text"] == "Hello everyone. Let's start. Let's review the frame 12 calculations."
    assert result["dialogue"].startswith("[00:00 - 00:06] **Participant 1:** Hello everyone. Let's start.")
    assert result["audio_url"] == "/api/voice/audio/voice_20261018_130000.wav"
    assert "Diarizing speakers..." in stages
    assert path.with_suffix(".txt").read_text(encoding="utf-8").startswith("Recording: voice_20261018_130000.wav")


def test_compute_fbank_shape():
    feats = voice.compute_fbank(np.random.default_rng(0).standard_normal(16000) * 0.1)
    assert feats.shape == (98, 80)  # 1 s: (16000 - 400) // 160 + 1 frames
    assert feats.dtype == np.float32
    assert np.allclose(feats.mean(axis=0), 0, atol=1e-4)  # mean-normalised


def test_resample_and_downmix_and_mix():
    stereo = np.array([1000, 3000] * 4410, dtype=np.int16).tobytes()  # 0.1 s at 44.1 kHz
    mono = voice.resample_and_downmix(stereo, 44100, 2)
    assert len(mono) == 1600 and np.all(mono == 2000)
    mixed = voice.mix(np.full(4, 30000, dtype=np.int16), np.full(2, 30000, dtype=np.int16))
    assert list(mixed) == [32767, 32767, 27000, 27000]


# --- Tagging participants -----------------------------------------------------------------------------------------


def test_tag_participant_renames_their_turns():
    block = {"id": "lw_abc", **FAKE_RESULT}
    tagged = voice.tag_participant(block, "Participant 2", "Bob", "bob@spirityachts.com")

    assert "**Bob:** Let's review" in tagged["dialogue"]
    assert "Participant 2" not in tagged["dialogue"]
    assert tagged["participants"][1] == {**FAKE_RESULT["participants"][1], "display_name": "Bob", "is_tagged": True, "email": "bob@spirityachts.com"}
    assert block["participants"][1]["display_name"] == "Participant 2"  # not changed in place
    assert voice.has_untagged(block) and not voice.has_untagged(tagged)


def test_tag_participant_endpoint_enrolls_and_updates_the_note(client, notes_dir):
    np.save(voice.embeddings_dir() / "voice_20261018_130000_2.npy", BOB)
    block = {"id": "lw_abc", "status": "completed", **FAKE_RESULT}
    write_note(notes_dir, "Review.md", f"Before.\n\n{voice.listen_block_markdown(block)}\n")

    response = client.post(
        "/api/voice/tag-participant",
        json={
            "speaker_id": "Participant 2",
            "alias": " Bob ",
            "audio_stem": "voice_20261018_130000",
            "cluster_id": 2,
            "block": block,
            "widget_id": "lw_abc",
            "note_path": "Review.md",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["note_updated"] is True
    assert body["has_untagged"] is False
    assert "**Bob:**" in body["block"]["dialogue"]
    assert body["contact"]["name"] == "Bob" and body["contact"]["sample_count"] == 1
    saved = json.loads(voice.LISTEN_FENCE.search(file_layer.read_note("Review.md", notes_dir=notes_dir)["content"]).group(1))
    assert saved["participants"][1]["display_name"] == "Bob"
    # Bob is recognised from now on.
    assert voice.identify_speaker(BOB)["name"] == "Bob"
    assert client.get("/api/voice/contacts").json()[0]["has_voiceprint"] is True


def test_tag_participant_without_a_note_returns_the_tagged_block(client):
    response = client.post(
        "/api/voice/tag-participant",
        json={"speaker_id": "Participant 2", "alias": "Bob", "block": {"id": "lw_abc", **FAKE_RESULT}},
    )
    assert response.status_code == 200
    assert response.json()["note_updated"] is False
    assert response.json()["block"]["participants"][1]["display_name"] == "Bob"
    assert response.json()["contact"]["sample_count"] == 0  # no embedding kept: named, but no voiceprint


def test_tag_participant_as_a_person_added_to_people(client):
    """The widget's picker adds a typed name to People, then tags the speaker with that person's name and email."""
    person = client.post("/api/people", json={"space_id": 1, "name": " Sarah Connor ", "is_external": False}).json()
    assert person["name"] == "Sarah Connor" and person["email"] is None

    response = client.post(
        "/api/voice/tag-participant",
        json={
            "speaker_id": "Participant 2",
            "alias": person["name"],
            "email": person["email"],
            "block": {"id": "lw_abc", **FAKE_RESULT},
        },
    )

    assert response.status_code == 200
    tagged = response.json()["block"]["participants"][1]
    assert tagged["display_name"] == "Sarah Connor" and tagged["is_tagged"] is True
    assert "**Sarah Connor:** Let's review" in response.json()["block"]["dialogue"]
    assert [p["name"] for p in client.get("/api/people?space_id=1").json()] == ["Sarah Connor"]


def test_retag_participant_renames_them_as_someone_else():
    block = {"id": "lw_abc", **FAKE_RESULT}
    retagged = voice.tag_participant(block, "Participant 1", "Carol")

    assert "**Carol:** Hello." in retagged["dialogue"]
    assert "Alice" not in retagged["dialogue"]
    assert retagged["participants"][0]["display_name"] == "Carol" and retagged["participants"][0]["is_tagged"] is True
    assert retagged["participants"][0]["email"] == ""  # Alice's email isn't Carol's
    assert retagged["participants"][1] == FAKE_RESULT["participants"][1]
    # Tagging with the same name again keeps the email.
    assert voice.tag_participant(block, "Participant 1", "Alice")["participants"][0]["email"] == "alice@spirityachts.com"


def test_untag_participant_sets_them_back_to_unidentified():
    block = {"id": "lw_abc", **FAKE_RESULT}
    untagged = voice.untag_participant(block, "Participant 1")

    assert "**Participant 1:** Hello." in untagged["dialogue"]
    assert "Alice" not in untagged["dialogue"]
    assert untagged["participants"][0] == {**FAKE_RESULT["participants"][0], "display_name": "Participant 1", "is_tagged": False, "email": ""}
    assert block["participants"][0]["display_name"] == "Alice"  # not changed in place
    assert voice.untag_participant(block, "Participant 9") is block


def test_untag_participant_endpoint_updates_the_note(client, notes_dir):
    block = {"id": "lw_abc", "status": "completed", **FAKE_RESULT}
    write_note(notes_dir, "Review.md", f"Before.\n\n{voice.listen_block_markdown(block)}\n")

    response = client.post(
        "/api/voice/untag-participant",
        json={"speaker_id": "Participant 1", "block": block, "widget_id": "lw_abc", "note_path": "Review.md"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["note_updated"] is True and body["has_untagged"] is True and body["contact"] == {}
    assert "**Participant 1:** Hello." in body["block"]["dialogue"]
    saved = json.loads(voice.LISTEN_FENCE.search(file_layer.read_note("Review.md", notes_dir=notes_dir)["content"]).group(1))
    assert saved["participants"][0]["display_name"] == "Participant 1" and saved["participants"][0]["is_tagged"] is False
    assert "**Participant 1:** Hello." in saved["dialogue"]


def test_untag_participant_without_a_note_returns_the_untagged_block(client):
    response = client.post(
        "/api/voice/untag-participant", json={"speaker_id": "Participant 1", "block": {"id": "lw_abc", **FAKE_RESULT}}
    )
    assert response.status_code == 200
    assert response.json()["note_updated"] is False
    assert response.json()["block"]["participants"][0]["is_tagged"] is False


# --- The listen block ---------------------------------------------------------------------------------------------


def test_listen_block_round_trip():
    data = {"id": "lw_abc", "dialogue": "Line one\n\nSay `this` ```", "participants": []}
    content = f"Intro\n\n{voice.listen_block_markdown(data)}\n\n{IDLE_BLOCK.replace('lw_abc', 'lw_other')}\n"

    updated = voice.update_listen_block(content, "lw_abc", lambda old: {**old, "status": "completed"})

    blocks = [json.loads(m.group(1)) for m in voice.LISTEN_FENCE.finditer(updated)]
    assert blocks[0] == {**data, "status": "completed"}
    assert blocks[1]["id"] == "lw_other"
    assert voice.update_listen_block(content, "lw_missing", lambda old: old) is None
