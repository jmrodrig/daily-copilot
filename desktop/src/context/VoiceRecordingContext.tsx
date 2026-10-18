import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { errorDetail, getJson, message, sendJson } from "../lib/api";
import { startClientAudioRecording, type ClientRecorder } from "../lib/clientAudio";
import { setTitleStatus } from "../lib/title";

/** What a recording captures: the microphone, the system audio (the other side of a Teams call), or both. */
export type VoiceSource = "mic" | "loopback" | "mixed";

// The app's one recording (see VoiceStatus in backend/schemas.py, which GET /api/voice/recording/status gives for a
// recording the backend makes): this window's, another window's, or the backend's.
export type VoiceStatus = {
  is_recording: boolean;
  is_paused: boolean;
  // Stopped and being transcribed (`stage` says how far it's got).
  is_processing: boolean;
  stage: string | null;
  elapsed_seconds: number;
  source: string | null;
  started_at: string | null;
  widget_id: string | null;
  space_id: number | null;
  note_path: string | null;
};

export type ListenParticipant = {
  speaker_id: string;
  display_name: string;
  is_tagged: boolean;
  email?: string;
  cluster_id?: number | null;
  audio_stem?: string | null;
  snippet_url?: string | null;
  sample_text?: string;
  // One clip per speaker merged into this participant (tagged as the same person), when there are several.
  snippets?: VoiceClip[];
};

/** A clip of one speaker's voice: their snippet (if one was saved) and what they said in it. */
export type VoiceClip = {
  speaker_id?: string;
  cluster_id?: number | null;
  audio_stem?: string | null;
  snippet_url?: string | null;
  sample_text?: string;
};

/** A listen widget's data, as its ```listen block in the note holds it (see noteFormatting). */
export type ListenData = {
  id: string;
  status: "idle" | "completed";
  source?: VoiceSource | "upload";
  recorded_at?: string;
  duration?: number;
  audio_file?: string;
  audio_url?: string;
  dialogue?: string;
  full_text?: string;
  participants?: ListenParticipant[];
};

// POST /api/voice/transcribe (or /api/voice/recording/stop): the widget's completed data, and whether it was written
// into the note on disk.
export type VoiceResult = ListenData & { note_updated: boolean; note_path: string | null };

const IDLE: VoiceStatus = {
  is_recording: false,
  is_paused: false,
  is_processing: false,
  stage: null,
  elapsed_seconds: 0,
  source: null,
  started_at: null,
  widget_id: null,
  space_id: null,
  note_path: null,
};

// The backend's status is polled this often (ms): briskly while it's recording or transcribing, so the clock and the
// progress keep up, else just enough to see a recording started there.
const ACTIVE_POLL = 1000;
const IDLE_POLL = 5000;
// The window making a recording tells the others how it's going this often (ms); one not heard from for a while has
// gone (closed without saying so).
const HEARTBEAT = 2000;
const PEER_TIMEOUT = 3 * HEARTBEAT;

/**
 * What the app's windows tell each other: "changed" (look at the backend again), the recording one of them is making
 * (null once it's done), a request for it (from a window just opened), or a request to the window making it to pause,
 * resume, stop or drop it (its widget was used, or removed, in another window).
 */
type VoiceMessage =
  | "changed"
  | { type: "recording"; status: VoiceStatus | null }
  | { type: "ask" }
  | { type: "command"; action: "pause" | "resume" | "stop" | "cancel"; widgetId: string | null };

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("copilot:voice") : null;
const post = (msg: VoiceMessage) => {
  try {
    channel?.postMessage(msg);
  } catch {
    // ignore
  }
};
const broadcast = () => post("changed");

/** `01:23`, or `1:02:03` from an hour on. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// The microphone to record from (this machine's, see clientAudio): its default when not given.
type StartOptions = {
  widgetId: string;
  source: VoiceSource;
  spaceId: number;
  notePath: string;
  micDeviceId?: string | null;
};

type VoiceRecording = {
  status: VoiceStatus;
  /** Seconds recorded so far (pauses left out), ticking while it records. */
  elapsed: number;
  /** Something's recording or being transcribed, here or in another window: no other widget may start. */
  busy: boolean;
  /** The recording's widget is on a page of this window (so leaving the page asks first). */
  recordingHere: boolean;
  /** Finished recordings, by widget, till their widget takes them (see `takeResult`). */
  results: Record<string, VoiceResult>;
  /** Why a widget's recording couldn't be transcribed. */
  stopErrors: Record<string, string>;
  start: (options: StartOptions) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /**
   * Stop the recording; resolves once it's transcribed (null if it couldn't be, see `stopErrors`, or if another
   * window is making it, which is asked to stop it).
   */
  stop: () => Promise<VoiceResult | null>;
  /** Stop the recording and throw it away (its widget is being removed). */
  cancel: () => Promise<void>;
  takeResult: (widgetId: string) => void;
  clearStopError: (widgetId: string) => void;
  /** A widget is shown (till the returned function is called). */
  registerWidget: (widgetId: string) => () => void;
};

/** The recording this window is making, from this machine's microphone or system audio (see clientAudio). */
type LocalSession = {
  /** Null once it's stopped, while it's uploaded and transcribed. */
  recorder: ClientRecorder | null;
  widgetId: string;
  spaceId: number;
  notePath: string;
  source: VoiceSource;
  startedAt: string;
  /** Seconds recorded before the last resume, and when that was (performance.now()): null while paused. */
  accumulated: number;
  resumedAt: number | null;
  /** How far the transcription's got, once stopped. */
  stage: string | null;
};

function sessionElapsed(session: LocalSession): number {
  return session.accumulated + (session.resumedAt === null ? 0 : (performance.now() - session.resumedAt) / 1000);
}

function sessionStatus(session: LocalSession): VoiceStatus {
  return {
    is_recording: session.recorder !== null,
    is_paused: session.resumedAt === null,
    is_processing: session.recorder === null,
    stage: session.stage,
    elapsed_seconds: sessionElapsed(session),
    source: session.source,
    started_at: session.startedAt,
    widget_id: session.widgetId,
    space_id: session.spaceId,
    note_path: session.notePath,
  };
}

/** POST a form, calling `onSent` once it's all gone up (the response only comes once the backend's done with it). */
function postForm<T>(url: string, form: FormData, onSent: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onload = onSent;
    xhr.onload = () => {
      // Wrapped in a Response so errors read the same as the rest of the API's.
      const res = new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText });
      if (!res.ok) return void errorDetail(res).then((detail) => reject(new Error(detail)), reject);
      res.json().then((body: T) => resolve(body), reject);
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(form);
  });
}

const VoiceRecordingContext = createContext<VoiceRecording | null>(null);

/**
 * The app's one voice recording, shared by every listen widget, the title bar's indicator and the note page's guard
 * against leaving it. It's recorded in the browser, from the machine the app is used on (see clientAudio), by the
 * window it was started in, which tells the app's other windows how it's going; on Stop it's uploaded, and the backend
 * transcribes it into its widget's block in the note (see backend/voice.py). A recording the backend itself is making
 * (one started before recordings moved to the browser) is still mirrored from its status, polled.
 */
export function VoiceRecordingProvider({ children }: { children: ReactNode }) {
  // The backend's recording, and when its status was fetched (performance.now()), for the clock to count on from.
  const [backendStatus, setBackendStatus] = useState<VoiceStatus>(IDLE);
  const [fetchedAt, setFetchedAt] = useState(0);
  // This window's recording, and another window's (as it last said, and when).
  const [local, setLocal] = useState<{ status: VoiceStatus; at: number } | null>(null);
  const [peer, setPeer] = useState<{ status: VoiceStatus; at: number } | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const [results, setResults] = useState<Record<string, VoiceResult>>({});
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const [mounted, setMounted] = useState<Record<string, number>>({});
  const sessionRef = useRef<LocalSession | null>(null);
  // A stop of the backend's recording in flight: the status polled meanwhile mustn't flip the widget back to recording.
  const stoppingRef = useRef(false);

  const apply = useCallback((next: VoiceStatus) => {
    if (stoppingRef.current && next.is_recording) return;
    setBackendStatus(next);
    setFetchedAt(performance.now());
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await getJson<VoiceStatus>("/api/voice/recording/status"));
    } catch {
      // The backend's away: keep what we had.
    }
  }, [apply]);

  /** Show this window's recording as it is now, and tell the other windows. */
  const publish = useCallback(() => {
    const session = sessionRef.current;
    const next = session ? sessionStatus(session) : null;
    setLocal(next ? { status: next, at: performance.now() } : null);
    post({ type: "recording", status: next });
  }, []);

  const view = local ?? peer ?? { status: backendStatus, at: fetchedAt };
  const status = view.status;
  const busy = status.is_recording || status.is_processing;
  const backendBusy = backendStatus.is_recording || backendStatus.is_processing;

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), backendBusy ? ACTIVE_POLL : IDLE_POLL);
    return () => window.clearInterval(timer);
  }, [backendBusy, refresh]);

  // The latest handlers, for the channel's listener to call when another window asks.
  const handlersRef = useRef<Record<"pause" | "resume" | "stop" | "cancel", () => Promise<unknown>> | null>(null);

  useEffect(() => {
    const look = () => void refresh();
    const visible = () => document.visibilityState === "visible" && look();
    const hear = (event: MessageEvent<VoiceMessage>) => {
      const msg = event.data;
      if (msg === "changed") return look();
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "recording") {
        setPeer(msg.status ? { status: msg.status, at: performance.now() } : null);
      } else if (msg.type === "ask") {
        if (sessionRef.current) publish();
      } else if (msg.type === "command") {
        const session = sessionRef.current;
        if (!session || (msg.widgetId && msg.widgetId !== session.widgetId)) return;
        void handlersRef.current?.[msg.action]().catch(() => {});
      }
    };
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", visible);
    channel?.addEventListener("message", hear);
    post({ type: "ask" });
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", visible);
      channel?.removeEventListener("message", hear);
    };
  }, [refresh, publish]);

  // While this window records, it keeps telling the others (and says when it's closed); they let go of a recording
  // they've stopped hearing about.
  const recordingLocally = local !== null;
  useEffect(() => {
    if (!recordingLocally) return;
    const timer = window.setInterval(publish, HEARTBEAT);
    const gone = () => post({ type: "recording", status: null });
    window.addEventListener("pagehide", gone);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", gone);
    };
  }, [recordingLocally, publish]);
  useEffect(() => {
    if (!peer) return;
    const timer = window.setTimeout(() => setPeer(null), PEER_TIMEOUT);
    return () => window.clearTimeout(timer);
  }, [peer]);

  // The clock ticks while it records.
  useEffect(() => {
    if (!status.is_recording || status.is_paused) return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [status.is_recording, status.is_paused]);

  const elapsed = status.is_recording
    ? status.elapsed_seconds + (status.is_paused ? 0 : Math.max(0, now - view.at) / 1000)
    : 0;

  const recordingHere = status.is_recording && status.widget_id !== null && (mounted[status.widget_id] ?? 0) > 0;

  // The window's title says it's recording ("⚪ Listening (01:23)"), whichever page is shown.
  const clock = formatClock(elapsed);
  useEffect(() => {
    setTitleStatus(
      status.is_recording
        ? status.is_paused
          ? `⏸ Paused (${clock})`
          : `⚪ Listening (${clock})`
        : status.is_processing
          ? "⏳ Transcribing"
          : "",
    );
  }, [status.is_recording, status.is_paused, status.is_processing, clock]);
  useEffect(() => () => setTitleStatus(""), []);

  // Closing or reloading the window asks first: this window makes its recording, so closing it loses the recording
  // (or, while it's uploaded, its transcript); and the window showing the recording's widget asks too.
  const guardUnload = recordingLocally || recordingHere;
  useEffect(() => {
    if (!guardUnload) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [guardUnload]);

  const statusRef = useRef(status);
  statusRef.current = status;
  const peerRef = useRef(peer);
  peerRef.current = peer;

  /** If another window is making the recording, ask it to `action` it (and say so). */
  const commandPeer = useCallback((action: "pause" | "resume" | "stop" | "cancel") => {
    if (sessionRef.current || !peerRef.current) return false;
    post({ type: "command", action, widgetId: peerRef.current.status.widget_id });
    return true;
  }, []);

  // A recording the backend makes (see the provider's doc): stopped there, and transcribed while the request is out.
  const stopBackend = useCallback(async (): Promise<VoiceResult | null> => {
    const widgetId = statusRef.current.widget_id;
    stoppingRef.current = true;
    setBackendStatus((current) => ({ ...current, is_recording: false, is_paused: false, is_processing: true, stage: "Finishing the recording..." }));
    try {
      const result = await sendJson<VoiceResult>("POST", "/api/voice/recording/stop");
      setResults((current) => ({ ...current, [result.id]: result }));
      return result;
    } catch (err) {
      if (widgetId) setStopErrors((current) => ({ ...current, [widgetId]: message(err) }));
      return null;
    } finally {
      stoppingRef.current = false;
      broadcast();
      void refresh();
    }
  }, [refresh]);

  const stop = useCallback(async (): Promise<VoiceResult | null> => {
    const session = sessionRef.current;
    if (!session) return commandPeer("stop") ? null : stopBackend();
    const recorder = session.recorder;
    if (!recorder) return null; // Stopped already: it's being transcribed.
    session.accumulated = sessionElapsed(session);
    session.resumedAt = null;
    session.recorder = null;
    session.stage = "Uploading audio for offline transcription...";
    publish();
    try {
      const audio = await recorder.stop();
      if (!audio.size) throw new Error("Nothing was recorded.");
      const form = new FormData();
      form.append("file", audio, `recording${recorder.extension}`);
      form.append("widget_id", session.widgetId);
      form.append("space_id", String(session.spaceId));
      form.append("note_path", session.notePath);
      form.append("source", session.source);
      const result = await postForm<VoiceResult>("/api/voice/transcribe", form, () => {
        if (sessionRef.current !== session) return;
        session.stage = "Transcribing...";
        publish();
      });
      setResults((current) => ({ ...current, [result.id]: result }));
      return result;
    } catch (err) {
      setStopErrors((current) => ({ ...current, [session.widgetId]: message(err) }));
      return null;
    } finally {
      if (sessionRef.current === session) sessionRef.current = null;
      publish();
      // The note on disk has the result: other windows showing it reload it.
      broadcast();
    }
  }, [commandPeer, stopBackend, publish]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = useCallback(
    async ({ widgetId, source, spaceId, notePath, micDeviceId = null }: StartOptions) => {
      if (sessionRef.current || statusRef.current.is_recording || statusRef.current.is_processing) {
        throw new Error("Another recording is running: only one can listen at a time.");
      }
      const recorder: ClientRecorder = await startClientAudioRecording(source, {
        micDeviceId: micDeviceId ?? undefined,
        // A source that stops by itself (the screen share ended from the browser's bar, say) stops the recording, which
        // is then transcribed as if Stop were pressed.
        onEnded: () => {
          if (sessionRef.current?.recorder === recorder) void stopRef.current();
        },
      });
      sessionRef.current = {
        recorder,
        widgetId,
        spaceId,
        notePath,
        source,
        startedAt: new Date().toISOString().slice(0, 19),
        accumulated: 0,
        resumedAt: performance.now(),
        stage: null,
      };
      setStopErrors(({ [widgetId]: _gone, ...rest }) => rest);
      publish();
    },
    [publish],
  );

  const pause = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      if (commandPeer("pause")) return;
      apply(await sendJson<VoiceStatus>("POST", "/api/voice/recording/pause"));
      broadcast();
      return;
    }
    if (!session.recorder || session.resumedAt === null) return;
    session.recorder.pause();
    session.accumulated = sessionElapsed(session);
    session.resumedAt = null;
    publish();
  }, [commandPeer, apply, publish]);

  const resume = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      if (commandPeer("resume")) return;
      apply(await sendJson<VoiceStatus>("POST", "/api/voice/recording/resume"));
      broadcast();
      return;
    }
    if (!session.recorder || session.resumedAt !== null) return;
    session.recorder.resume();
    session.resumedAt = performance.now();
    publish();
  }, [commandPeer, apply, publish]);

  const cancel = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      if (commandPeer("cancel")) return;
      if (!statusRef.current.is_recording) return;
      // The backend's: stopped, and its transcript not kept.
      const result = await stopBackend();
      if (result) setResults(({ [result.id]: _dropped, ...rest }) => rest);
      return;
    }
    // Being transcribed already: with its widget gone, the result lands nowhere.
    if (!session.recorder) return;
    session.recorder.cleanup();
    sessionRef.current = null;
    publish();
  }, [commandPeer, stopBackend, publish]);

  handlersRef.current = { pause, resume, stop, cancel };

  const takeResult = useCallback((widgetId: string) => {
    setResults(({ [widgetId]: _taken, ...rest }) => rest);
  }, []);

  const clearStopError = useCallback((widgetId: string) => {
    setStopErrors(({ [widgetId]: _gone, ...rest }) => rest);
  }, []);

  const registerWidget = useCallback((widgetId: string) => {
    setMounted((current) => ({ ...current, [widgetId]: (current[widgetId] ?? 0) + 1 }));
    return () =>
      setMounted((current) => {
        const count = (current[widgetId] ?? 1) - 1;
        const { [widgetId]: _gone, ...rest } = current;
        return count > 0 ? { ...rest, [widgetId]: count } : rest;
      });
  }, []);

  const value = useMemo<VoiceRecording>(
    () => ({
      status,
      elapsed,
      busy,
      recordingHere,
      results,
      stopErrors,
      start,
      pause,
      resume,
      stop,
      cancel,
      takeResult,
      clearStopError,
      registerWidget,
    }),
    [status, elapsed, busy, recordingHere, results, stopErrors, start, pause, resume, stop, cancel, takeResult, clearStopError, registerWidget],
  );

  return <VoiceRecordingContext.Provider value={value}>{children}</VoiceRecordingContext.Provider>;
}

export function useVoiceRecording(): VoiceRecording {
  const context = useContext(VoiceRecordingContext);
  if (!context) throw new Error("useVoiceRecording must be used inside VoiceRecordingProvider");
  return context;
}
