"""Voice notes: capture the microphone and/or the system audio (a Teams call, through WASAPI loopback), transcribe it
offline with faster-whisper, and attribute the dialogue to speakers (WeSpeaker CAM++ embeddings, clustered, then
matched against enrolled voiceprints). Ported from First Mate (`app/recorder.py`, `transcriber.py`, `contacts.py`).

Everything is kept under `<data_dir>/voice/`:

    recordings/          the recorded (or uploaded) audio, with a `.txt` transcript beside each
    snippets/            a short clip of each speaker who wasn't recognised, to listen to before naming them
    embeddings/          each recording's per-speaker embedding, read when a speaker is tagged
    voiceprints/<id>.npy an enrolled contact's voiceprint
    contacts.json        the enrolled contacts (name, email)

A recording is embedded in its note as a ```listen fenced block of JSON on one line (see `listen_block_markdown`), the
way a whiteboard is. Only one recording runs at a time, across the app (`SESSION`).

The heavy libraries (pyaudiowpatch, faster-whisper, onnxruntime, scipy, av) are imported when first used, so the
backend starts, and its tests run, without them.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import queue
import re
import threading
import time
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from config import BACKEND_DIR, get_settings

logger = logging.getLogger(__name__)

# Suppress Hugging Face's symlink warning on Windows without developer mode.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

SPEAKER_MODEL_PATH = BACKEND_DIR / "models" / "wespeaker_en_voxceleb_CAM++.onnx"
# Fetched from here when it isn't in backend/models/.
SPEAKER_MODEL_REPO = ("csukuangfj/speaker-embedding-models", "wespeaker_en_voxceleb_CAM++.onnx")

# What a recording captures: the microphone, the system audio (what the speakers play: the other side of a call), or both.
SOURCES = ("mic", "loopback", "mixed")
TARGET_RATE = 16000  # what Whisper and CAM++ expect

# Cosine similarity a speaker's embedding must reach to be taken for an enrolled voiceprint.
MATCH_THRESHOLD = 0.72
# Clustering (cosine distance): below SINGLE_SPEAKER_DISTANCE at the top merge it's one speaker; else clusters are cut here.
SINGLE_SPEAKER_DISTANCE = 0.68
CLUSTER_DISTANCE = 0.78
# A speaker's snippet: their first turn of this many seconds, else their longest.
SNIPPET_SECONDS = (2.0, 6.0)
# A pause this long (s) starts a new turn even when the speaker hasn't changed.
TURN_PAUSE_SECONDS = 4.0

# Recording and snippet file names: no folders, no dot files.
_FILE_NAME_RE = re.compile(r"\A[\w-][\w.-]*\Z")


class VoiceError(Exception):
    """A recording can't be started or handled (no audio device, say); the message says why."""


class SessionBusyError(VoiceError):
    """A recording is already running (or still being transcribed): there's only ever one."""


class NoSessionError(VoiceError):
    """There's no recording to pause, resume or stop."""


# --- Storage ---------------------------------------------------------------------------------------------------


def voice_dir() -> Path:
    return get_settings().data_dir / "voice"


def _dir(name: str) -> Path:
    path = voice_dir() / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def recordings_dir() -> Path:
    return _dir("recordings")


def snippets_dir() -> Path:
    return _dir("snippets")


def embeddings_dir() -> Path:
    return _dir("embeddings")


def voiceprints_dir() -> Path:
    return _dir("voiceprints")


def contacts_file() -> Path:
    return voice_dir() / "contacts.json"


def stored_file(folder: Path, name: str) -> Path:
    """`name` in `folder` (a recording or a snippet), refusing anything that isn't a plain file name there."""
    if not _FILE_NAME_RE.match(name):
        raise ValueError(f"Not a file name: {name!r}")
    path = folder / name
    if not path.is_file():
        raise FileNotFoundError(name)
    return path


def audio_url(name: str) -> str:
    return f"/api/voice/audio/{name}"


def snippet_url(name: str) -> str:
    return f"/api/voice/snippets/{name}"


def new_recording_path(suffix: str = ".wav") -> Path:
    """`recordings/voice_<timestamp><suffix>`, never an existing file."""
    folder = recordings_dir()
    stem = f"voice_{datetime.datetime.now():%Y%m%d_%H%M%S}"
    path, n = folder / f"{stem}{suffix}", 1
    while path.exists():
        n += 1
        path = folder / f"{stem}_{n}{suffix}"
    return path


# --- Audio devices and capture ---------------------------------------------------------------------------------


def _pyaudio():
    try:
        import pyaudiowpatch
    except ImportError as exc:  # not installed, or not on Windows
        raise VoiceError("Audio capture needs pyaudiowpatch (Windows only): pip install pyaudiowpatch") from exc
    return pyaudiowpatch


def _default_devices(pa, p) -> tuple[int | None, int | None]:
    """The default microphone's index and the default speakers' WASAPI loopback's."""
    mic = loopback = None
    try:
        mic = p.get_default_input_device_info()["index"]
    except Exception:  # noqa: BLE001 - no input device
        pass
    try:
        wasapi = p.get_host_api_info_by_type(pa.paWASAPI)["index"]
        loopback = next((d["index"] for d in p.get_loopback_device_info_generator() if d.get("hostApi") == wasapi), None)
    except Exception:  # noqa: BLE001 - no WASAPI
        pass
    if loopback is None:
        for i in range(p.get_device_count()):
            try:
                if p.get_device_info_by_index(i).get("isLoopbackDevice"):
                    loopback = i
                    break
            except Exception:  # noqa: BLE001
                continue
    return mic, loopback


def list_audio_devices() -> dict[str, Any]:
    """The microphones and system-audio (loopback) devices to record from, with the defaults' indexes."""
    pa = _pyaudio()
    p = pa.PyAudio()
    devices: dict[str, Any] = {"mics": [], "loopbacks": []}
    try:
        for i in range(p.get_device_count()):
            try:
                info = p.get_device_info_by_index(i)
            except Exception:  # noqa: BLE001
                continue
            channels = int(info.get("maxInputChannels", 0))
            if channels <= 0:
                continue
            try:
                host_api = p.get_host_api_info_by_index(info.get("hostApi"))["name"]
            except Exception:  # noqa: BLE001
                host_api = ""
            device = {
                "index": i,
                "name": info.get("name", f"Device {i}"),
                "host_api": host_api,
                "channels": channels,
                "default_samplerate": int(info.get("defaultSampleRate", 44100)),
            }
            devices["loopbacks" if info.get("isLoopbackDevice") else "mics"].append(device)
        devices["default_mic_index"], devices["default_loopback_index"] = _default_devices(pa, p)
    finally:
        p.terminate()
    return devices


def resample_and_downmix(raw: bytes, src_rate: int, src_channels: int, target_rate: int = TARGET_RATE) -> np.ndarray:
    """Interleaved int16 PCM bytes as mono int16 samples at `target_rate`."""
    if not raw:
        return np.empty(0, dtype=np.int16)
    data = np.frombuffer(raw, dtype=np.int16)
    if src_channels > 1:
        frames = len(data) // src_channels
        mono = data[: frames * src_channels].reshape((frames, src_channels)).astype(np.float32).mean(axis=1)
    else:
        mono = data.astype(np.float32)
    if len(mono) == 0:
        return np.empty(0, dtype=np.int16)
    if src_rate != target_rate:
        length = int(len(mono) * target_rate / src_rate)
        if length <= 0:
            return np.empty(0, dtype=np.int16)
        mono = np.interp(np.linspace(0, len(mono), length, endpoint=False), np.arange(len(mono)), mono)
    return np.clip(mono, -32768, 32767).astype(np.int16)


def mix(mic: np.ndarray, loop: np.ndarray) -> np.ndarray:
    """Two mono int16 streams summed into one, with headroom so they don't clip."""
    if not len(mic):
        return loop
    if not len(loop):
        return mic
    length = max(len(mic), len(loop))
    mixed = np.pad(mic.astype(np.float32), (0, length - len(mic))) * 0.9 + np.pad(loop.astype(np.float32), (0, length - len(loop))) * 0.9
    return np.clip(mixed, -32768, 32767).astype(np.int16)


class DualStreamRecorder:
    """Records the microphone and/or a WASAPI loopback device into one 16 kHz mono WAV.

    Each stream's callback queues its raw buffers; a writer thread resamples, mixes and writes them as they come.
    A device given as None isn't opened.
    """

    def __init__(self, output_path: Path, mic_index: int | None, loopback_index: int | None) -> None:
        self.output_path = output_path
        self.mic_index = mic_index
        self.loopback_index = loopback_index
        self._pa = None
        self._streams: list[Any] = []
        self._mic_queue: queue.Queue[bytes] = queue.Queue()
        self._loop_queue: queue.Queue[bytes] = queue.Queue()
        self._mic_format = (TARGET_RATE, 1)
        self._loop_format = (44100, 2)
        self._recording = False
        self._paused = False
        self._stop = threading.Event()
        self._writer: threading.Thread | None = None
        self._started = 0.0
        self._paused_total = 0.0
        self._paused_at = 0.0

    @property
    def is_paused(self) -> bool:
        return self._paused

    def duration(self) -> float:
        """Seconds recorded, leaving out pauses."""
        if not self._recording:
            return 0.0
        now = time.time()
        active = now - self._started - self._paused_total - ((now - self._paused_at) if self._paused else 0.0)
        return max(0.0, active)

    def _open(self, p, index: int, queue_: queue.Queue[bytes], loopback: bool) -> tuple[int, int]:
        pa = _pyaudio()
        info = p.get_device_info_by_index(index)
        rate = int(info.get("defaultSampleRate", 44100 if loopback else TARGET_RATE))
        channels = max(1, int(info.get("maxInputChannels", 2 if loopback else 1)))
        if not loopback:
            channels = min(channels, 2)

        def callback(in_data, _frame_count, _time_info, _status):
            if self._recording and not self._paused and in_data:
                queue_.put(in_data)
            return (None, pa.paContinue)

        stream = p.open(
            format=pa.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=index,
            stream_callback=callback,
            frames_per_buffer=2048,
        )
        stream.start_stream()
        self._streams.append(stream)
        logger.info("Recording %s (device %s, %s Hz, %s ch)", "loopback" if loopback else "microphone", index, rate, channels)
        return rate, channels

    def start(self) -> None:
        pa = _pyaudio()
        self._pa = pa.PyAudio()
        self._recording = True
        self._started = time.time()
        errors = []
        if self.mic_index is not None:
            try:
                self._mic_format = self._open(self._pa, self.mic_index, self._mic_queue, loopback=False)
            except Exception as exc:  # noqa: BLE001 - reported below if nothing opened
                errors.append(f"microphone: {exc}")
        if self.loopback_index is not None:
            try:
                self._loop_format = self._open(self._pa, self.loopback_index, self._loop_queue, loopback=True)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"system audio: {exc}")
        if not self._streams:
            self._recording = False
            self._pa.terminate()
            self._pa = None
            raise VoiceError("Could not open an audio device (" + "; ".join(errors or ["none chosen"]) + ")")
        for error in errors:
            logger.warning("Recording without the %s", error)
        self._writer = threading.Thread(target=self._write, daemon=True)
        self._writer.start()

    def pause(self) -> None:
        if self._recording and not self._paused:
            self._paused = True
            self._paused_at = time.time()

    def resume(self) -> None:
        if self._recording and self._paused:
            self._paused_total += time.time() - self._paused_at
            self._paused = False

    def stop(self) -> Path:
        """Close the devices and finish the WAV file."""
        self._recording = False
        self._paused = False
        self._stop.set()
        for stream in self._streams:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:  # noqa: BLE001
                pass
        self._streams = []
        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:  # noqa: BLE001
                pass
            self._pa = None
        if self._writer and self._writer.is_alive():
            self._writer.join(timeout=5.0)
        return self.output_path

    @staticmethod
    def _drain(queue_: queue.Queue[bytes], rate: int, channels: int) -> np.ndarray:
        chunks = []
        while True:
            try:
                chunk = resample_and_downmix(queue_.get_nowait(), rate, channels)
            except queue.Empty:
                break
            if len(chunk):
                chunks.append(chunk)
        return np.concatenate(chunks) if chunks else np.empty(0, dtype=np.int16)

    def _write(self) -> None:
        with wave.open(str(self.output_path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(TARGET_RATE)
            while not self._stop.is_set() or not self._mic_queue.empty() or not self._loop_queue.empty():
                mixed = mix(self._drain(self._mic_queue, *self._mic_format), self._drain(self._loop_queue, *self._loop_format))
                if len(mixed):
                    out.writeframes(mixed.tobytes())
                else:
                    time.sleep(0.05)


def source_devices(source: str, mic_index: int | None, loopback_index: int | None) -> tuple[int | None, int | None]:
    """The microphone and loopback devices `source` records from: the ones chosen, else the defaults."""
    if source not in SOURCES:
        raise VoiceError(f"Unknown audio source: {source}")
    if (source != "loopback" and mic_index is None) or (source != "mic" and loopback_index is None):
        pa = _pyaudio()
        p = pa.PyAudio()
        try:
            default_mic, default_loopback = _default_devices(pa, p)
        finally:
            p.terminate()
        mic_index = default_mic if mic_index is None else mic_index
        loopback_index = default_loopback if loopback_index is None else loopback_index
    mic = mic_index if source in ("mic", "mixed") else None
    loop = loopback_index if source in ("loopback", "mixed") else None
    if mic is None and loop is None:
        raise VoiceError("No audio device found for " + ("the microphone" if source == "mic" else "the system audio"))
    return mic, loop


# --- The one recording session ---------------------------------------------------------------------------------


class VoiceSession:
    """The app's single recording: who started it (a note's listen widget), and where it's got to. Once stopped it's
    `processing` till its transcript is done (`finish`); a new recording can't start before then."""

    # Swapped in tests for a recorder that doesn't need audio devices.
    recorder_factory: Callable[[Path, int | None, int | None], Any] = DualStreamRecorder

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._recorder: Any = None
        self.source: str | None = None
        self.owner: dict[str, Any] = {}
        self.started_at: str | None = None
        self.processing = False
        self.stage: str | None = None

    def start(self, source: str, mic_index: int | None, loopback_index: int | None, owner: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if self._recorder is not None:
                raise SessionBusyError("A recording is already running: stop it before starting another.")
            if self.processing:
                raise SessionBusyError("The last recording is still being transcribed: wait for it to finish.")
            mic, loop = source_devices(source, mic_index, loopback_index)
            recorder = self.recorder_factory(new_recording_path(), mic, loop)
            recorder.start()
            self._recorder = recorder
            self.source = source
            self.owner = dict(owner)
            self.started_at = datetime.datetime.now().replace(microsecond=0).isoformat()
            self.stage = None
        return self.status()

    def _running(self) -> Any:
        if self._recorder is None:
            raise NoSessionError("No recording is running.")
        return self._recorder

    def pause(self) -> dict[str, Any]:
        with self._lock:
            self._running().pause()
        return self.status()

    def resume(self) -> dict[str, Any]:
        with self._lock:
            self._running().resume()
        return self.status()

    def stop(self) -> tuple[Path, str, dict[str, Any]]:
        """Stop capturing: the recorded file, its source and its owner. The session is `processing` from here."""
        with self._lock:
            recorder = self._running()
            self.processing = True
            self.stage = "Finishing the recording..."
            self._recorder = None
            source, owner = self.source or "mic", self.owner
        try:
            path = recorder.stop()
        except Exception:
            self.finish()
            raise
        return path, source, owner

    def set_stage(self, stage: str) -> None:
        self.stage = stage

    def finish(self) -> None:
        """The stopped recording has been transcribed (or failed to be): the session is free again."""
        with self._lock:
            self.processing = False
            self.stage = None
            self.source = None
            self.owner = {}
            self.started_at = None

    def status(self) -> dict[str, Any]:
        recorder = self._recorder
        return {
            "is_recording": recorder is not None,
            "is_paused": bool(recorder is not None and recorder.is_paused),
            "is_processing": self.processing,
            "stage": self.stage,
            "elapsed_seconds": round(recorder.duration(), 2) if recorder is not None else 0.0,
            "source": self.source,
            "started_at": self.started_at,
            "widget_id": self.owner.get("widget_id"),
            "space_id": self.owner.get("space_id"),
            "note_path": self.owner.get("note_path"),
        }


SESSION = VoiceSession()


# --- Transcription and diarization -----------------------------------------------------------------------------

_whisper_model: Any = None
_whisper_model_name: str | None = None
_speaker_session: Any = None
# One transcription at a time: they're CPU-bound, and share the cached models.
_TRANSCRIBE_LOCK = threading.Lock()


def get_whisper_model(name: str | None = None) -> Any:
    """The cached faster-whisper model (`base.en` unless configured), on the CPU in int8."""
    global _whisper_model, _whisper_model_name
    name = name or get_settings().whisper_model
    if _whisper_model is None or _whisper_model_name != name:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise VoiceError("Transcription needs faster-whisper: pip install faster-whisper") from exc
        logger.info("Loading Whisper model %s (CPU, int8)", name)
        _whisper_model = WhisperModel(name, device="cpu", compute_type="int8")
        _whisper_model_name = name
    return _whisper_model


def get_speaker_session() -> Any:
    """The cached ONNX session of the WeSpeaker CAM++ speaker-embedding model, or None if it can't be loaded."""
    global _speaker_session
    if _speaker_session is not None:
        return _speaker_session
    try:
        import onnxruntime as ort

        path = SPEAKER_MODEL_PATH
        if not path.exists():
            from huggingface_hub import hf_hub_download

            path = Path(hf_hub_download(*SPEAKER_MODEL_REPO))
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        _speaker_session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
    except Exception as exc:  # noqa: BLE001 - without it, everyone is one speaker
        logger.warning("Speaker embeddings unavailable: %s", exc)
        return None
    return _speaker_session


def format_timestamp(seconds: float) -> str:
    """`MM:SS`, or `HH:MM:SS` from an hour on."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def compute_fbank(signal: np.ndarray, sr: int = TARGET_RATE, n_mels: int = 80, frame_ms: int = 25, shift_ms: int = 10) -> np.ndarray:
    """80-bin log Mel filterbank features (with cepstral mean normalisation), as WeSpeaker CAM++ takes them."""
    signal = np.asarray(signal, dtype=np.float64)
    if sr != TARGET_RATE:
        import scipy.signal

        signal = scipy.signal.resample(signal, int(len(signal) * TARGET_RATE / sr))
        sr = TARGET_RATE
    signal = np.append(signal[0], signal[1:] - 0.97 * signal[:-1])  # pre-emphasis

    frame_len = int(sr * frame_ms / 1000)
    frame_shift = int(sr * shift_ms / 1000)
    if len(signal) < frame_len:
        signal = np.pad(signal, (0, frame_len - len(signal)))
    num_frames = max(1, (len(signal) - frame_len) // frame_shift + 1)
    indices = np.arange(frame_len)[None, :] + (np.arange(num_frames) * frame_shift)[:, None]
    frames = signal[indices] * np.hamming(frame_len)

    nfft = 512
    power = (np.absolute(np.fft.rfft(frames, nfft)) ** 2) / nfft
    high_mel = 2595 * np.log10(1 + (sr / 2) / 700)
    hz = 700 * (10 ** (np.linspace(0, high_mel, n_mels + 2) / 2595) - 1)
    bins = np.floor((nfft + 1) * hz / sr).astype(int)
    fbank = np.zeros((n_mels, nfft // 2 + 1))
    for m in range(1, n_mels + 1):
        left, centre, right = bins[m - 1], bins[m], bins[m + 1]
        for k in range(left, centre):
            fbank[m - 1, k] = (k - left) / (centre - left)
        for k in range(centre, right):
            fbank[m - 1, k] = (right - k) / (right - centre)
    features = power @ fbank.T
    features = np.log(np.where(features == 0, np.finfo(float).eps, features))
    features -= features.mean(axis=0)
    return features.astype(np.float32)


def normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 1e-6 else vector


def extract_speaker_embedding(chunk: np.ndarray, sr: int) -> np.ndarray | None:
    """A 512-dim L2-normalised CAM++ embedding of the speech in `chunk`; None for under a quarter second."""
    if len(chunk) < int(sr * 0.25):
        return None
    session = get_speaker_session()
    if session is None:
        return None
    try:
        feats = compute_fbank(chunk, sr=sr)[None, :, :]  # (1, frames, 80)
        return normalize(session.run(None, {"feats": feats})[0][0])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Speaker embedding failed: %s", exc)
        return None


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    """Any audio file (WAV, M4A...) decoded as mono float samples, with its sample rate."""
    import av

    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        sr = stream.rate
        # Downmixed to mono float by FFmpeg, whatever the file's sample format and layout (packed or planar).
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sr)
        chunks = [out.to_ndarray().reshape(-1) for frame in container.decode(stream) for out in resampler.resample(frame)]
        chunks += [out.to_ndarray().reshape(-1) for out in resampler.resample(None)]
    if not chunks:
        return np.empty(0, dtype=np.float32), sr
    return np.concatenate(chunks).astype(np.float32), sr


def save_wav(samples: np.ndarray, sr: int, path: Path) -> None:
    """Float samples (-1..1) saved as a 16-bit mono WAV."""
    pcm = (np.asarray(samples, dtype=np.float32) * 32767.0).clip(-32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sr)
        out.writeframes(pcm.tobytes())


def cluster_speakers(embeddings: list[np.ndarray]) -> list[int]:
    """Each embedding's speaker, numbered from 1 in the order they first speak (agglomerative, average linkage)."""
    if len(embeddings) < 2:
        return [1] * len(embeddings)
    import scipy.cluster.hierarchy as sch
    import scipy.spatial.distance as ssd

    embs = np.array(embeddings)
    distances = np.clip(1.0 - embs @ embs.T, 0.0, 2.0)
    np.fill_diagonal(distances, 0.0)
    linkage = sch.linkage(ssd.squareform(distances, checks=False), method="average")
    if linkage[-1, 2] < SINGLE_SPEAKER_DISTANCE:
        return [1] * len(embeddings)
    labels = sch.fcluster(linkage, t=CLUSTER_DISTANCE, criterion="distance")
    if len(set(labels)) < 2:
        labels = sch.fcluster(linkage, t=2, criterion="maxclust")
    order: dict[int, int] = {}
    return [order.setdefault(int(label), len(order) + 1) for label in labels]


def _best_segment(segments: list[dict[str, Any]]) -> dict[str, Any] | None:
    low, high = SNIPPET_SECONDS
    return next((s for s in segments if low <= s["end"] - s["start"] <= high), None) or max(
        segments, key=lambda s: s["end"] - s["start"], default=None
    )


def diarize_segments(segments: list[dict[str, Any]], audio_path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    """Who says each segment, and the participants: each speaker's averaged embedding is kept (for tagging later)
    and matched against the voiceprints; one who isn't recognised gets a snippet of their voice to listen to."""
    if not segments:
        return [], []
    stem = audio_path.stem
    try:
        data, sr = load_audio(audio_path)
    except Exception as exc:  # noqa: BLE001 - one unknown speaker, then
        logger.warning("Could not read %s for diarization: %s", audio_path.name, exc)
        data, sr = None, TARGET_RATE

    embeddings, valid = [], []
    if data is not None:
        for i, seg in enumerate(segments):
            emb = extract_speaker_embedding(data[max(0, int(seg["start"] * sr)) : int(seg["end"] * sr)], sr)
            if emb is not None:
                embeddings.append(emb)
                valid.append(i)
    labels = cluster_speakers(embeddings)

    # Segments too short to embed take their neighbour's speaker.
    by_segment = dict(zip(valid, labels))
    assignments: list[int] = []
    for i in range(len(segments)):
        if i in by_segment:
            assignments.append(by_segment[i])
        elif assignments:
            assignments.append(assignments[-1])
        else:
            assignments.append(next((by_segment[j] for j in valid if j > i), 1))

    participants: list[dict[str, Any]] = []
    names: dict[int, str] = {}
    for cid in sorted(set(assignments)):
        cluster_embs = [emb for emb, label in zip(embeddings, labels) if label == cid]
        mean = normalize(np.mean(cluster_embs, axis=0)) if cluster_embs else None
        if mean is not None:
            np.save(str(embeddings_dir() / f"{stem}_{cid}.npy"), mean)
        best = _best_segment([s for s, c in zip(segments, assignments) if c == cid])
        match = identify_speaker(mean) if mean is not None else None
        speaker_id = f"Participant {cid}"
        participant = {
            "speaker_id": speaker_id,
            "display_name": match["name"] if match else speaker_id,
            "cluster_id": cid,
            "audio_stem": stem,
            "is_tagged": match is not None,
            "email": match.get("email", "") if match else "",
            "snippet_url": None,
            "sample_text": best["text"] if best else "",
        }
        if not match and best and data is not None:
            snippet = snippets_dir() / f"{stem}_participant_{cid}.wav"
            try:
                save_wav(data[max(0, int(best["start"] * sr)) : int(best["end"] * sr)], sr, snippet)
                participant["snippet_url"] = snippet_url(snippet.name)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Could not save the snippet of %s: %s", speaker_id, exc)
        names[cid] = participant["display_name"]
        participants.append(participant)
    return [names[c] for c in assignments], participants


def build_dialogue(segments: list[dict[str, Any]], speakers: list[str]) -> str:
    """The segments grouped into speaker turns: `[00:00 - 00:15] **Alice:** ...`, a blank line between turns."""
    turns: list[str] = []
    speaker: str | None = None
    words: list[str] = []
    start = end = 0.0
    for seg, spk in zip(segments, speakers):
        if words and (spk != speaker or seg["start"] - end > TURN_PAUSE_SECONDS):
            turns.append(f"[{format_timestamp(start)} - {format_timestamp(end)}] **{speaker}:** {' '.join(words)}")
            words = []
        if not words:
            start, speaker = seg["start"], spk
        words.append(seg["text"])
        end = seg["end"]
    if words:
        turns.append(f"[{format_timestamp(start)} - {format_timestamp(end)}] **{speaker}:** {' '.join(words)}")
    return "\n\n".join(turns)


def transcribe_audio(path: Path, progress: Callable[[str], None] | None = None) -> dict[str, Any]:
    """Transcribe a recording offline and attribute it to speakers. The transcript is also saved beside it (.txt)."""
    if not path.is_file():
        raise FileNotFoundError(path.name)
    report = progress or (lambda _stage: None)
    settings = get_settings()
    language = settings.whisper_language if settings.whisper_language not in ("", "auto") else None
    with _TRANSCRIBE_LOCK:
        report("Loading the speech model...")
        model = get_whisper_model()
        report("Transcribing with Whisper...")
        generated, info = model.transcribe(
            str(path), beam_size=3, language=language, vad_filter=True, vad_parameters={"min_silence_duration_ms": 500}
        )
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        segments: list[dict[str, Any]] = []
        for seg in generated:
            text = seg.text.strip()
            if text:
                segments.append({"start": float(seg.start), "end": float(seg.end), "text": text})
                report(f"Transcribing with Whisper... ({format_timestamp(seg.end)} of {format_timestamp(duration)})")
        report("Diarizing speakers...")
        speakers, participants = diarize_segments(segments, path)

    full_text = " ".join(s["text"] for s in segments)
    dialogue = build_dialogue(segments, speakers) or full_text
    try:
        path.with_suffix(".txt").write_text(
            f"Recording: {path.name}\nDuration: {format_timestamp(duration)}\n\n{dialogue}\n", encoding="utf-8"
        )
    except OSError as exc:
        logger.warning("Could not save the transcript of %s: %s", path.name, exc)
    return {
        "duration": round(duration, 2),
        "audio_file": path.name,
        "audio_url": audio_url(path.name),
        "participants": participants,
        "dialogue": dialogue,
        "full_text": full_text,
    }


# --- Contacts and voiceprints ----------------------------------------------------------------------------------


def contact_id(name: str) -> str:
    """A file-name-safe id for a contact's name."""
    slug = re.sub(r"[^\w-]", "_", name.strip().lower())
    return re.sub(r"_+", "_", slug).strip("_") or "contact"


def load_contacts() -> list[dict[str, Any]]:
    path = contacts_file()
    if not path.exists():
        return []
    try:
        contacts = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("Could not read %s: %s", path, exc)
        return []
    return contacts if isinstance(contacts, list) else []


def save_contacts(contacts: list[dict[str, Any]]) -> None:
    path = contacts_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(contacts, indent=2, ensure_ascii=False), encoding="utf-8")


def list_contacts() -> list[dict[str, Any]]:
    """The contacts, each with whether a voiceprint is enrolled for them."""
    folder = voiceprints_dir()
    return [
        {
            "id": c["id"],
            "name": c["name"],
            "email": c.get("email", ""),
            "has_voiceprint": (folder / f"{c['id']}.npy").exists(),
            "sample_count": c.get("sample_count", 0),
        }
        for c in load_contacts()
    ]


def save_contact(name: str, email: str | None = None, embedding: np.ndarray | None = None) -> dict[str, Any]:
    """Create or update a contact by name; an embedding enrols (or, blended 60/40 with the old one, refines) their
    voiceprint."""
    name = name.strip()
    if not name:
        raise ValueError("A name is required")
    contacts = load_contacts()
    cid = contact_id(name)
    existing = next((c for c in contacts if c.get("id") == cid or c.get("name", "").strip().lower() == name.lower()), None)
    if existing:
        cid = existing["id"]
    now = datetime.datetime.now().replace(microsecond=0).isoformat()

    if embedding is not None:
        emb = normalize(embedding)
        path = voiceprints_dir() / f"{cid}.npy"
        if path.exists():
            try:
                emb = normalize(0.6 * np.load(str(path)) + 0.4 * emb)
            except (OSError, ValueError) as exc:
                logger.warning("Replacing the unreadable voiceprint of %s: %s", name, exc)
        np.save(str(path), emb)

    if existing:
        existing["name"] = name
        if email is not None:
            existing["email"] = email.strip()
        existing["updated_at"] = now
        existing["sample_count"] = existing.get("sample_count", 0) + (embedding is not None)
        contact = existing
    else:
        contact = {
            "id": cid,
            "name": name,
            "email": (email or "").strip(),
            "created_at": now,
            "updated_at": now,
            "sample_count": int(embedding is not None),
        }
        contacts.append(contact)
    save_contacts(contacts)
    return contact


def identify_speaker(embedding: np.ndarray | None, threshold: float = MATCH_THRESHOLD) -> dict[str, Any] | None:
    """The enrolled contact whose voiceprint is most like `embedding` (cosine similarity), if it reaches `threshold`."""
    if embedding is None:
        return None
    emb = normalize(embedding)
    if np.linalg.norm(emb) < 1e-6:
        return None
    folder = voiceprints_dir()
    best, best_sim = None, -1.0
    for contact in load_contacts():
        path = folder / f"{contact['id']}.npy"
        if not path.exists():
            continue
        try:
            sim = float(np.dot(emb, normalize(np.load(str(path)))))
        except (OSError, ValueError) as exc:
            logger.warning("Could not read the voiceprint of %s: %s", contact.get("name"), exc)
            continue
        if sim > best_sim:
            best, best_sim = contact, sim
    if best is None or best_sim < threshold:
        return None
    return {**best, "similarity": round(best_sim, 3)}


def tag_participant(
    block: dict[str, Any], speaker_id: str, alias: str, email: str | None = None
) -> dict[str, Any]:
    """`block` (a listen widget's data) with the participant `speaker_id` named `alias`: their entry is marked tagged
    and their turns in the dialogue renamed. Doesn't touch the contacts (see `enroll_participant`)."""
    alias = alias.strip()
    participants = [dict(p) for p in block.get("participants") or []]
    target = next((p for p in participants if p.get("speaker_id") == speaker_id), None)
    if target is None:
        return block
    old_name = target.get("display_name") or speaker_id
    target.update(display_name=alias, is_tagged=True, email=(email or "").strip() or target.get("email", ""))
    dialogue = str(block.get("dialogue") or "").replace(f"**{old_name}:**", f"**{alias}:**")
    return {**block, "participants": participants, "dialogue": dialogue}


def has_untagged(block: dict[str, Any]) -> bool:
    return any(not p.get("is_tagged") for p in block.get("participants") or [])


def enroll_participant(alias: str, email: str | None, audio_stem: str | None, cluster_id: int | None) -> dict[str, Any]:
    """Save `alias` as a contact, enrolling the voiceprint of their cluster in the recording `audio_stem` if it was
    kept (see `diarize_segments`)."""
    embedding = None
    if audio_stem and cluster_id is not None and _FILE_NAME_RE.match(audio_stem):
        path = embeddings_dir() / f"{audio_stem}_{cluster_id}.npy"
        if path.exists():
            try:
                embedding = np.load(str(path))
            except (OSError, ValueError) as exc:
                logger.warning("Could not read %s: %s", path.name, exc)
    return save_contact(alias, email=email, embedding=embedding)


# --- The listen block in a note --------------------------------------------------------------------------------

LISTEN_FENCE = re.compile(r"^ {0,3}```listen[ \t]*\r?\n(.*?)\r?\n {0,3}```[ \t]*$", re.MULTILINE | re.DOTALL)


def listen_block_markdown(data: dict[str, Any]) -> str:
    """A listen widget's data as its fenced block: JSON on one line, with no backtick to end the fence early."""
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("`", "\\u0060")
    return f"```listen\n{text}\n```"


def update_listen_block(content: str, widget_id: str, update: Callable[[dict[str, Any]], dict[str, Any]]) -> str | None:
    """`content` with the listen block whose `id` is `widget_id` passed through `update`; None if there's no such block."""
    for match in LISTEN_FENCE.finditer(content):
        try:
            data = json.loads(match.group(1))
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("id") == widget_id:
            return content[: match.start()] + listen_block_markdown(update(data)) + content[match.end() :]
    return None


def completed_block(widget_id: str, source: str, result: dict[str, Any]) -> dict[str, Any]:
    """A listen widget's data once its recording is transcribed."""
    return {
        "id": widget_id,
        "status": "completed",
        "source": source,
        "recorded_at": datetime.datetime.now().replace(microsecond=0).isoformat(),
        **result,
    }
