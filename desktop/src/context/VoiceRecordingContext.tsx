import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getJson, message, sendJson } from "../lib/api";
import { setTitleStatus } from "../lib/title";

/** What a recording captures: the microphone, the system audio (the other side of a Teams call), or both. */
export type VoiceSource = "mic" | "loopback" | "mixed";

// GET /api/voice/recording/status (see VoiceStatus in backend/schemas.py): the app's one recording.
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

// POST /api/voice/recording/stop: the widget's completed data, and whether it was written into the note on disk.
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

// The status is polled this often (ms): briskly while something's recording or transcribing, so the clock and the
// progress keep up, else just enough to see a recording started in another window.
const ACTIVE_POLL = 1000;
const IDLE_POLL = 5000;

// Tells the app's other windows the recording changed, so they look again straight away.
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("copilot:voice") : null;
const broadcast = () => {
  try {
    channel?.postMessage("changed");
  } catch {
    // ignore
  }
};

/** `01:23`, or `1:02:03` from an hour on. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type StartOptions = { widgetId: string; source: VoiceSource; spaceId: number; notePath: string };

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
  /** Stop the recording; resolves once it's transcribed (null if it couldn't be, see `stopErrors`). */
  stop: () => Promise<VoiceResult | null>;
  takeResult: (widgetId: string) => void;
  clearStopError: (widgetId: string) => void;
  /** A widget is shown (till the returned function is called). */
  registerWidget: (widgetId: string) => () => void;
};

const VoiceRecordingContext = createContext<VoiceRecording | null>(null);

/**
 * The app's one voice recording (see backend/voice.py), shared by every listen widget, the title bar's indicator and
 * the note page's guard against leaving it. The backend holds the recording, so this only mirrors its status, polled
 * (and refreshed at once when this or another window changes it).
 */
export function VoiceRecordingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VoiceStatus>(IDLE);
  // When the status was fetched (performance.now()), for the clock to count on from.
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const [results, setResults] = useState<Record<string, VoiceResult>>({});
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const [mounted, setMounted] = useState<Record<string, number>>({});
  // A stop in flight: the status polled meanwhile mustn't flip the widget back to recording.
  const stoppingRef = useRef(false);

  const apply = useCallback((next: VoiceStatus) => {
    if (stoppingRef.current && next.is_recording) return;
    setStatus(next);
    setFetchedAt(performance.now());
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await getJson<VoiceStatus>("/api/voice/recording/status"));
    } catch {
      // The backend's away: keep what we had.
    }
  }, [apply]);

  const busy = status.is_recording || status.is_processing;

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), busy ? ACTIVE_POLL : IDLE_POLL);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  useEffect(() => {
    const look = () => void refresh();
    const visible = () => document.visibilityState === "visible" && look();
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", visible);
    channel?.addEventListener("message", look);
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", visible);
      channel?.removeEventListener("message", look);
    };
  }, [refresh]);

  // The clock ticks while it records.
  useEffect(() => {
    if (!status.is_recording || status.is_paused) return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [status.is_recording, status.is_paused]);

  const elapsed = status.is_recording
    ? status.elapsed_seconds + (status.is_paused ? 0 : Math.max(0, now - fetchedAt) / 1000)
    : 0;

  const recordingHere = status.is_recording && status.widget_id !== null && (mounted[status.widget_id] ?? 0) > 0;

  // The window's title says it's recording ("🔴 Listening (01:23)"), whichever page is shown.
  const clock = formatClock(elapsed);
  useEffect(() => {
    setTitleStatus(
      status.is_recording
        ? status.is_paused
          ? `⏸ Paused (${clock})`
          : `🔴 Listening (${clock})`
        : status.is_processing
          ? "⏳ Transcribing"
          : "",
    );
  }, [status.is_recording, status.is_paused, status.is_processing, clock]);
  useEffect(() => () => setTitleStatus(""), []);

  // Closing or reloading the window asks first. (The recording carries on in the backend if it's closed anyway, and
  // its widget picks it up again when the note is next opened.)
  useEffect(() => {
    if (!recordingHere) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [recordingHere]);

  const start = useCallback(
    async ({ widgetId, source, spaceId, notePath }: StartOptions) => {
      const next = await sendJson<VoiceStatus>("POST", "/api/voice/recording/start", {
        widget_id: widgetId,
        source,
        space_id: spaceId,
        note_path: notePath,
      });
      setStopErrors(({ [widgetId]: _gone, ...rest }) => rest);
      apply(next);
      broadcast();
    },
    [apply],
  );

  const pause = useCallback(async () => {
    apply(await sendJson<VoiceStatus>("POST", "/api/voice/recording/pause"));
    broadcast();
  }, [apply]);

  const resume = useCallback(async () => {
    apply(await sendJson<VoiceStatus>("POST", "/api/voice/recording/resume"));
    broadcast();
  }, [apply]);

  const statusRef = useRef(status);
  statusRef.current = status;

  const stop = useCallback(async () => {
    const widgetId = statusRef.current.widget_id;
    stoppingRef.current = true;
    // Straight to processing, while the request (which runs till the transcript's done) is out.
    setStatus((current) => ({ ...current, is_recording: false, is_paused: false, is_processing: true, stage: "Finishing the recording..." }));
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
      takeResult,
      clearStopError,
      registerWidget,
    }),
    [status, elapsed, busy, recordingHere, results, stopErrors, start, pause, resume, stop, takeResult, clearStopError, registerWidget],
  );

  return <VoiceRecordingContext.Provider value={value}>{children}</VoiceRecordingContext.Provider>;
}

export function useVoiceRecording(): VoiceRecording {
  const context = useContext(VoiceRecordingContext);
  if (!context) throw new Error("useVoiceRecording must be used inside VoiceRecordingProvider");
  return context;
}
