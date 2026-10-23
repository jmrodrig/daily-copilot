import type { VoiceSource } from "../context/VoiceRecordingContext";

/**
 * Recording a listen widget in the browser, from the machine the app is used on (which, over Tailscale, isn't the one
 * the backend runs on): its microphone (getUserMedia), its system audio (getDisplayMedia: the other side of a Teams
 * call, shared from a screen or tab with its audio), or both mixed (Web Audio). MediaRecorder makes WebM/Opus of it,
 * which the backend transcribes once it's stopped (POST /api/voice/transcribe).
 */

/** A microphone of this machine, as the browser lists it (its label only once the page may use the microphone). */
export type ClientAudioInput = { deviceId: string; label: string };

export type ClientRecorder = {
  /** The recording's MIME type (`audio/webm;codecs=opus`, say), and the file extension that goes with it. */
  mimeType: string;
  extension: string;
  pause: () => void;
  resume: () => void;
  /** Stop recording and let go of the devices: the recording. */
  stop: () => Promise<Blob>;
  getStream: () => MediaStream;
  /** Let go of the devices, keeping nothing (the recording's being thrown away). */
  cleanup: () => void;
};

export type ClientRecordingOptions = {
  /** The microphone to record (the default one when not given). */
  micDeviceId?: string;
  /** A captured source stopped by itself (the screen share was ended from the browser's bar, a mic unplugged). */
  onEnded?: () => void;
};

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];

/** Why this page can't record at all, or null if it can. */
export function clientAudioUnavailable(): string | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return typeof window !== "undefined" && !window.isSecureContext
      ? "The browser only lets a secure page record: open the app over https (or on localhost) to listen here."
      : "This browser can't record audio.";
  }
  if (typeof MediaRecorder === "undefined") return "This browser can't record audio (no MediaRecorder).";
  return null;
}

function bestMimeType(): string {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? "";
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("mp4")) return ".m4a";
  return ".webm";
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

/** The microphones of this machine (the browser's own "default" and "communications" entries left out). */
export async function listClientAudioInputs(): Promise<ClientAudioInput[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

async function captureMic(micDeviceId?: string): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  if (micDeviceId) audio.deviceId = { exact: micDeviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      throw new Error("The browser wasn't allowed to use the microphone: allow it for this site and try again.");
    }
    if (err instanceof DOMException && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
      throw new Error("That microphone wasn't found: plug it in, or pick another one.");
    }
    throw err;
  }
}

/** The system audio, shared from a screen or a tab: only its audio is kept (the video is let go at once). */
async function captureSystemAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error("This browser can't capture the system audio.");
  let shared: MediaStream;
  try {
    shared = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new Error("The screen wasn't shared, so there's no system audio to record.");
    }
    throw err;
  }
  shared.getVideoTracks().forEach((track) => {
    track.stop();
    shared.removeTrack(track);
  });
  if (!shared.getAudioTracks().length) {
    stopTracks(shared);
    throw new Error('No audio was shared: share the screen (or the call\'s tab) again with "Share system audio" ticked.');
  }
  return shared;
}

/** Start recording `source` on this machine. */
export async function startClientAudioRecording(source: VoiceSource, options: ClientRecordingOptions = {}): Promise<ClientRecorder> {
  const unavailable = clientAudioUnavailable();
  if (unavailable) throw new Error(unavailable);

  const inputs: MediaStream[] = [];
  let context: AudioContext | null = null;
  const cleanup = () => {
    inputs.forEach(stopTracks);
    if (context && context.state !== "closed") void context.close().catch(() => {});
  };

  let stream: MediaStream;
  try {
    if (source !== "loopback") inputs.push(await captureMic(options.micDeviceId));
    if (source !== "mic") inputs.push(await captureSystemAudio());
    if (inputs.length === 1) {
      stream = new MediaStream(inputs[0].getAudioTracks());
    } else {
      // Both, mixed into one track.
      context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      for (const input of inputs) context.createMediaStreamSource(input).connect(destination);
      stream = destination.stream;
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  const mimeType = bestMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    cleanup();
    throw err;
  }
  const type = recorder.mimeType || mimeType || "audio/webm";
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type }));
  });

  let stopping = false;
  for (const input of inputs) {
    for (const track of input.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (!stopping) options.onEnded?.();
      });
    }
  }

  // In slices, so a long recording isn't held as one buffer till the end.
  recorder.start(1000);

  return {
    mimeType: type,
    extension: extensionFor(type),
    pause: () => {
      if (recorder.state === "recording") recorder.pause();
    },
    resume: () => {
      if (recorder.state === "paused") recorder.resume();
    },
    stop: async () => {
      stopping = true;
      if (recorder.state !== "inactive") recorder.stop();
      try {
        return await stopped;
      } finally {
        cleanup();
      }
    },
    getStream: () => stream,
    cleanup: () => {
      stopping = true;
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") recorder.stop();
      cleanup();
    },
  };
}
