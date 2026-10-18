import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import {
  formatClock,
  useVoiceRecording,
  type ListenData,
  type ListenParticipant,
  type VoiceSource,
} from "../context/VoiceRecordingContext";
import { getJson, message, promptCopilot, sendJson } from "../lib/api";
import { notifyNoteUpdated } from "../lib/notes";
import { notePath, useSpace } from "../lib/space";
import { ListenBlock } from "./noteFormatting";

const SOURCES: { value: VoiceSource; label: string }[] = [
  { value: "mic", label: "Default microphone" },
  { value: "loopback", label: "System audio (Teams / calls)" },
  { value: "mixed", label: "Mixed (microphone + system audio)" },
];

// GET /api/voice/devices (see AudioDevices in backend/schemas.py): what a recording can capture.
type AudioDevice = { index: number; name: string; host_api: string };
type AudioDevices = {
  mics: AudioDevice[];
  loopbacks: AudioDevice[];
  default_mic_index: number | null;
  default_loopback_index: number | null;
};

/** A choice of the audio source picker: what to record, from which devices (the backend's defaults when null). */
type SourceOption = { key: string; source: VoiceSource; label: string; micIndex: number | null; loopbackIndex: number | null };

/** Each device once, by name (one may be listed under each of its host APIs): the default if it's among them. */
function uniqueByName(devices: AudioDevice[], defaultIndex: number | null): AudioDevice[] {
  const byName = new Map<string, AudioDevice>();
  for (const device of devices) {
    if (!byName.has(device.name) || device.index === defaultIndex) byName.set(device.name, device);
  }
  return [...byName.values()];
}

/**
 * The audio source picker's choices: each microphone (the default first), each system-audio device, and both mixed.
 * Without the devices (the backend couldn't list them) the plain sources, recorded from the backend's defaults.
 */
function sourceOptions(devices: AudioDevices | null): SourceOption[] {
  if (!devices || (!devices.mics.length && !devices.loopbacks.length)) {
    return SOURCES.map((s) => ({ key: s.value, source: s.value, label: s.label, micIndex: null, loopbackIndex: null }));
  }
  const isDefaultMic = (d: AudioDevice) => Number(d.index === devices.default_mic_index);
  const mics = uniqueByName(devices.mics, devices.default_mic_index).sort((a, b) => isDefaultMic(b) - isDefaultMic(a));
  const loopbacks = uniqueByName(devices.loopbacks, devices.default_loopback_index);
  const options: SourceOption[] = [
    ...mics.map((d) => ({
      key: `mic:${d.index}`,
      source: "mic" as const,
      label: isDefaultMic(d) ? `${d.name} (Default)` : d.name,
      micIndex: d.index,
      loopbackIndex: null,
    })),
    ...loopbacks.map((d) => ({
      key: `loopback:${d.index}`,
      source: "loopback" as const,
      label: `System Audio: ${d.name} (Teams / calls)`,
      micIndex: null,
      loopbackIndex: d.index,
    })),
  ];
  if (mics.length && loopbacks.length) {
    options.push({ key: "mixed", source: "mixed", label: "Mixed (Microphone + System Audio)", micIndex: null, loopbackIndex: null });
  }
  return options;
}

/** A microphone, in a 16 × 16 box. */
export function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0 M8 12.25v2 M5.75 14.25h4.5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
      <path d="M3 1.8v8.4L10 6z" />
    </svg>
  );
}

const TRASH_ICON = "M2.5 4.5h11 M6 4.5V3h4v1.5 M4 4.5l.7 9h6.6l.7-9 M6.8 7v4.5 M9.2 7v4.5";

function parse(value: string): ListenData | null {
  try {
    const data = JSON.parse(value);
    return data && typeof data === "object" && typeof data.id === "string" && data.id ? (data as ListenData) : null;
  } catch {
    return null;
  }
}

/** A dialogue turn: `[00:00 - 00:15] **Alice:** Hello...`. */
const TURN = /^\[([^\]]+)\]\s*\*\*(.+?):\*\*\s*([\s\S]*)$/;

/** The note this widget is in (from the page's URL), or null outside a note (a task's description, a template). */
function useNoteRef(): { spaceId: number; path: string } | null {
  const location = useLocation();
  const [params] = useSearchParams();
  const { spaceId: activeSpaceId } = useSpace();
  const path = params.get("path");
  if (location.pathname !== "/note" || !path || params.get("root") === "templates") return null;
  return { spaceId: Number(params.get("space") ?? activeSpaceId), path };
}

/**
 * A note's listen widget: pick what to record (the microphone, a call's system audio, or both) and start listening;
 * on Stop the backend transcribes it offline (Whisper) and works out who spoke (speaker embeddings), and the widget
 * shows the recording, the transcript by speaker, and the speakers, with a snippet to play for each one it didn't
 * recognise, to name them (and enrol their voice). Its result is saved in its ```listen block (see noteFormatting).
 *
 * Only one recording runs at a time, app-wide: while another widget (here or in another window) is recording, this one
 * can't start. Shown in the editor (`onChange` saves into the block) and on the read-only page (the backend writes the
 * block and the page reloads the note). With `interactive` false (a version history preview) it only shows.
 */
export default function ListenWidget({
  value,
  onChange,
  onRemove,
  interactive = true,
  selected = false,
}: {
  value: string;
  onChange?: (data: ListenData) => void;
  onRemove?: () => void;
  interactive?: boolean;
  selected?: boolean;
}) {
  const parsed = useMemo(() => parse(value), [value]);
  // What the page hasn't caught up with yet: a result or a tag, till the block (or the reloaded note) has it.
  const [override, setOverride] = useState<ListenData | null>(null);
  const data = override && override.id === parsed?.id ? override : parsed;
  const id = data?.id ?? "";
  const note = useNoteRef();
  const voice = useVoiceRecording();
  const { status, elapsed, busy, results, stopErrors } = voice;
  // The picked choice's key (see sourceOptions), or at first the source the widget last recorded.
  const [choice, setChoice] = useState<string>(() => (data?.source === "loopback" || data?.source === "mixed" ? data.source : "mic"));
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The devices to pick from, while there's a recording to make.
  const canRecord = interactive && Boolean(data) && data?.status !== "completed";
  useEffect(() => {
    if (!canRecord) return;
    let live = true;
    getJson<AudioDevices>("/api/voice/devices").then(
      (found) => live && setDevices(found),
      () => {}, // Not listed: the plain sources, recorded from the backend's defaults.
    );
    return () => {
      live = false;
    };
  }, [canRecord]);
  const options = useMemo(() => sourceOptions(devices), [devices]);
  // The picked choice, else (a plain source, or a device that's gone) the first of its source, else the first.
  const picked =
    options.find((o) => o.key === choice) ?? options.find((o) => o.source === choice.split(":")[0]) ?? options[0];

  useEffect(() => {
    setOverride((current) => (current && parsed && JSON.stringify(current) === JSON.stringify(parsed) ? null : current));
  }, [parsed]);

  useEffect(() => {
    if (!id || !interactive) return;
    return voice.registerWidget(id);
  }, [id, interactive, voice.registerWidget]);

  /** New data for the widget: shown at once, saved into the block (or, read-only, reloaded from the note on disk). */
  function update(next: ListenData, writtenToNote: boolean) {
    setOverride(next);
    if (onChange) onChange(next);
    else if (writtenToNote && note) notifyNoteUpdated(note.spaceId, note.path);
  }

  // The recording's transcript, once it's done.
  const result = id ? results[id] : undefined;
  const appliedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!result || !interactive || appliedRef.current === result) return;
    appliedRef.current = result;
    const { note_updated, note_path: _notePath, ...completed } = result;
    update(completed, note_updated);
    voice.takeResult(result.id);
  }, [result, interactive]);

  // A recording of this widget's, stopped from another window, has been transcribed there: the note on disk has it.
  const wasMineRef = useRef(false);
  const mine = Boolean(id) && status.widget_id === id;
  useEffect(() => {
    if (mine) wasMineRef.current = true;
    else if (wasMineRef.current && !busy) {
      wasMineRef.current = false;
      if (!result && !onChange && note) notifyNoteUpdated(note.spaceId, note.path);
    }
  }, [mine, busy]);

  if (!data) {
    return (
      <div className="my-4 rounded-lg border border-border-default px-4 py-3 text-[15px] text-text-muted print:hidden">
        This listen widget's data can't be read.
        {onRemove && (
          <button type="button" className="btn ml-3 min-h-8" onClick={onRemove}>
            Remove it
          </button>
        )}
      </div>
    );
  }

  const recording = mine && status.is_recording;
  const processing = mine && status.is_processing;
  const stopError = stopErrors[id];
  const lockedBy = busy && !mine ? status : null;

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(false);
    }
  }

  const start = () =>
    run(async () => {
      if (!note) return;
      voice.clearStopError(id);
      const { source, micIndex, loopbackIndex } = picked;
      if (data.source !== source && onChange) onChange({ ...data, source });
      await voice.start({ widgetId: id, source, spaceId: note.spaceId, notePath: note.path, micIndex, loopbackIndex });
    });

  return (
    <div
      data-listen-widget
      className={`listen-widget my-4 overflow-hidden rounded-lg border bg-surface-raised text-[15px] text-text-primary print:hidden ${
        recording ? "border-red-500/60" : selected ? "border-accent" : "border-border-default"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border-default px-4 py-2">
        <span className={recording ? "text-red-500" : "text-accent-soft"}>
          <MicIcon />
        </span>
        <span className="font-mono text-xs uppercase tracking-[0.06em] text-text-muted">
          {data.status === "completed" ? `Meeting recording${data.duration ? ` · ${formatClock(data.duration)}` : ""}` : "Listen"}
        </span>
        {data.recorded_at && <span className="text-xs text-text-muted">{data.recorded_at.replace("T", " ").slice(0, 16)}</span>}
        <span className="flex-1" />
        {/* Removing a widget that's recording, or holds a recording, asks first (see ListenRemovalGuard). */}
        {onRemove && interactive && (
          <button
            type="button"
            title="Remove the listen widget from the note"
            aria-label="Remove the listen widget from the note"
            onClick={onRemove}
            className="rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={TRASH_ICON} />
            </svg>
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-3">
        {recording ? (
          <Listening
            paused={status.is_paused}
            elapsed={elapsed}
            sourceLabel={picked.source === status.source ? picked.label : SOURCES.find((s) => s.value === status.source)?.label}
            pending={pending}
            onPause={() => run(status.is_paused ? voice.resume : voice.pause)}
            onStop={() => run(voice.stop)}
          />
        ) : processing ? (
          <div role="status" className="flex items-center gap-3 py-2 text-text-secondary">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            {status.stage ?? "Transcribing..."}
          </div>
        ) : data.status === "completed" ? (
          <Completed data={data} interactive={interactive} note={note} onTagged={update} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-text-secondary">
              <span className="sr-only">Audio source</span>
              <select
                aria-label="Audio source"
                value={picked.key}
                disabled={!interactive || pending || Boolean(lockedBy)}
                onChange={(e) => setChoice(e.target.value)}
                className="field w-auto max-w-full py-2"
              >
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-primary gap-2"
              disabled={!interactive || !note || pending || Boolean(lockedBy)}
              onClick={() => void start()}
            >
              <MicIcon />
              Start Listening
            </button>
            {!note && interactive && <span className="text-xs text-text-muted">Open the note itself to record here.</span>}
          </div>
        )}

        {lockedBy && interactive && !recording && !processing && data.status !== "completed" && (
          <p className="text-xs text-text-muted">
            {lockedBy.is_processing ? "Another recording is being transcribed" : "Another widget is recording"}
            {lockedBy.note_path && lockedBy.space_id !== null && (
              <>
                {" "}
                in{" "}
                <Link to={notePath(lockedBy.space_id, lockedBy.note_path)} className="text-accent hover:underline">
                  {lockedBy.note_path.split("/").pop()?.replace(/\.md$/i, "")}
                </Link>
              </>
            )}
            : only one can listen at a time.
          </p>
        )}
        {(error || stopError) && (
          <p role="alert" className="text-xs text-accent">
            {error ?? `The recording couldn't be transcribed: ${stopError}`}
          </p>
        )}
      </div>
    </div>
  );
}

function Listening({
  paused,
  elapsed,
  sourceLabel,
  pending,
  onPause,
  onStop,
}: {
  paused: boolean;
  elapsed: number;
  sourceLabel: string | undefined;
  pending: boolean;
  onPause: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className="flex items-center gap-2.5">
        <span className="relative flex h-3 w-3">
          {!paused && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />}
          <span className={`relative inline-flex h-3 w-3 rounded-full ${paused ? "bg-text-muted" : "bg-red-500"}`} />
        </span>
        <span className="font-mono text-[17px] tabular-nums">{formatClock(elapsed)}</span>
        <span className="text-text-secondary">{paused ? "Paused" : "Listening…"}</span>
      </span>
      {/* Activity: bars bobbing while it records (still while paused). */}
      <span aria-hidden className="flex h-6 items-center gap-[3px]">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span
            key={i}
            className={`h-full w-[3px] origin-center rounded-full bg-red-500/70 ${paused ? "scale-y-[0.3]" : "animate-voice-bar"}`}
            style={{ animationDelay: `${(i * 130) % 900}ms` }}
          />
        ))}
      </span>
      <span className="text-xs text-text-muted">{sourceLabel}</span>
      <span className="flex-1" />
      <button type="button" className="btn min-h-9" disabled={pending} onClick={onPause}>
        {paused ? "Resume" : "Pause"}
      </button>
      <button type="button" className="btn min-h-9 border-red-500/60 text-red-500 hover:bg-red-500/10" disabled={pending} onClick={onStop}>
        <span className="h-2.5 w-2.5 rounded-sm bg-current" />
        Stop
      </button>
    </div>
  );
}

const AI_ACTIONS: { label: string; prompt: (where: string) => string }[] = [
  {
    label: "Summarize Meeting",
    prompt: (where) =>
      `Summarize the meeting recorded in ${where}. Give a short overview, then the key points discussed by topic, noting who raised what.`,
  },
  {
    label: "Extract Action Items",
    prompt: (where) =>
      `Extract the action items from the meeting recorded in ${where}: for each, what is to be done, who owns it, and any due date mentioned. Add them to the note as a checklist under an "Action items" heading.`,
  },
  {
    label: "Extract Decisions",
    prompt: (where) =>
      `List the decisions made in the meeting recorded in ${where} (design decisions especially): each with the reasoning given and who made or agreed it.`,
  },
];

function Completed({
  data,
  interactive,
  note,
  onTagged,
}: {
  data: ListenData;
  interactive: boolean;
  note: { spaceId: number; path: string } | null;
  onTagged: (data: ListenData, writtenToNote: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const turns = (data.dialogue ?? "").split(/\n{2,}/).filter((turn) => turn.trim());
  const participants = data.participants ?? [];
  const where = note
    ? `the note ${note.path} (its transcript is the "dialogue" of the \`\`\`listen block recorded ${data.recorded_at?.replace("T", " ").slice(0, 16) ?? ""}, speakers in bold)`
    : "this note";

  return (
    <>
      {data.audio_url && (
        <audio controls preload="metadata" src={data.audio_url} className="h-9 w-full" />
      )}

      <div className="rounded-md border border-border-default">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-text-secondary hover:bg-surface-hover"
        >
          <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
          Transcript
          <span className="text-xs text-text-muted">
            {turns.length ? `${turns.length} turn${turns.length === 1 ? "" : "s"}` : "no speech detected"}
          </span>
        </button>
        {open && (
          <div className="max-h-[420px] overflow-y-auto border-t border-border-default px-3 py-2">
            {turns.length === 0 ? (
              <p className="text-text-muted">No speech was detected in the recording.</p>
            ) : (
              turns.map((turn, i) => {
                const match = TURN.exec(turn.trim());
                return match ? (
                  <p key={i} className="py-1 leading-relaxed">
                    <span className="mr-2 font-mono text-xs text-text-muted">{match[1]}</span>
                    <strong className="mr-1 text-accent-soft">{match[2]}:</strong>
                    {match[3]}
                  </p>
                ) : (
                  <p key={i} className="py-1 leading-relaxed">
                    {turn}
                  </p>
                );
              })
            )}
          </div>
        )}
      </div>

      {participants.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.06em] text-text-muted">Participants</span>
          {participants.map((p) =>
            p.is_tagged ? (
              <div key={p.speaker_id} className="flex items-center gap-2">
                <span className="rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[14px] text-emerald-500">
                  ✓ {p.display_name}
                </span>
                {p.email && <span className="text-xs text-text-muted">{p.email}</span>}
              </div>
            ) : (
              <UntaggedParticipant key={p.speaker_id} data={data} participant={p} interactive={interactive} note={note} onTagged={onTagged} />
            ),
          )}
        </div>
      )}

      {interactive && turns.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-default pt-3">
          <span className="text-xs text-text-muted">Ask the Co-pilot:</span>
          {AI_ACTIONS.map((action) => (
            <button key={action.label} type="button" className="btn min-h-8 px-2.5 text-[14px]" onClick={() => promptCopilot(action.prompt(where))}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// The known contacts' names, fetched once per page for the name suggestions.
let contactNames: Promise<string[]> | null = null;
const loadContactNames = () =>
  (contactNames ??= getJson<{ name: string }[]>("/api/voice/contacts").then(
    (contacts) => contacts.map((c) => c.name),
    () => {
      contactNames = null;
      return [];
    },
  ));

/** A speaker who wasn't recognised: play their snippet, name them, and enrol their voice. */
function UntaggedParticipant({
  data,
  participant,
  interactive,
  note,
  onTagged,
}: {
  data: ListenData;
  participant: ListenParticipant;
  interactive: boolean;
  note: { spaceId: number; path: string } | null;
  onTagged: (data: ListenData, writtenToNote: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audioRef.current?.pause(), []);
  const listId = `listen-contacts-${data.id}-${participant.cluster_id ?? participant.speaker_id}`;

  function play() {
    if (!participant.snippet_url) return;
    audioRef.current?.pause();
    audioRef.current = new Audio(participant.snippet_url);
    void audioRef.current.play().catch((err: unknown) => setError(`Could not play the snippet (${message(err)}).`));
  }

  async function tag() {
    const alias = name.trim();
    if (!alias) return;
    setSaving(true);
    setError(null);
    try {
      const response = await sendJson<{ block: ListenData; note_updated: boolean }>("POST", "/api/voice/tag-participant", {
        speaker_id: participant.speaker_id,
        alias,
        audio_stem: participant.audio_stem ?? null,
        cluster_id: participant.cluster_id ?? null,
        block: data,
        widget_id: data.id,
        space_id: note?.spaceId ?? 1,
        note_path: note?.path ?? null,
      });
      contactNames = null;
      onTagged(response.block, response.note_updated);
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void tag();
        }}
      >
        <span className="rounded border border-border-strong px-2 py-0.5 text-[14px] text-text-secondary">{participant.display_name}</span>
        <button
          type="button"
          title="Play a snippet of their voice"
          aria-label={`Play a snippet of ${participant.display_name}`}
          disabled={!participant.snippet_url}
          onClick={play}
          className="btn min-h-8 px-2"
        >
          <PlayIcon />
        </button>
        {interactive && (
          <>
            <input
              aria-label={`Name of ${participant.display_name}`}
              placeholder="Name"
              list={listId}
              value={name}
              disabled={saving}
              onFocus={() => void loadContactNames().then(setNames)}
              onChange={(e) => setName(e.target.value)}
              className="field w-44 py-1.5"
            />
            <datalist id={listId}>
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <button type="submit" className="btn-primary min-h-8 px-3 text-[14px]" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Tag & Enroll"}
            </button>
          </>
        )}
      </form>
      {participant.sample_text && <p className="pl-1 text-xs italic text-text-muted">“{participant.sample_text}”</p>}
      {error && <p className="text-xs text-accent">{error}</p>}
    </div>
  );
}

/** Why removing listen widgets asks first: one is recording or being transcribed, else one holds a recording. */
export type ListenRemoval = "active" | "recorded";

/** Set on an edit that removes a listen widget, once the removal is confirmed, for ListenRemovalGuard to let it through. */
export const LISTEN_REMOVAL_CONFIRMED = "listenRemovalConfirmed";

// A listen node's data, parsed once per node (nodes don't change: an edit makes new ones).
const parsedListenNodes = new WeakMap<ProseMirrorNode, ListenData | null>();

/** The listen widgets in `doc`, by id. */
function listenWidgets(doc: ProseMirrorNode): Map<string, ListenData> {
  const found = new Map<string, ListenData>();
  doc.descendants((node) => {
    if (node.type.name !== "listen") return !node.isTextblock;
    let data = parsedListenNodes.get(node);
    if (data === undefined) {
      data = typeof node.attrs.data === "string" ? parse(node.attrs.data) : null;
      parsedListenNodes.set(node, data);
    }
    if (data) found.set(data.id, data);
    return false;
  });
  return found;
}

/**
 * Holds back an edit that would take a listen widget out of the note while it's recording (or being transcribed), or
 * once it holds a recording, however it's taken out: Backspace or Delete on it, typing, pasting or cutting over it, its
 * trash button, an undo. `onBlocked` is given the edit, to ask first, and dispatch it again with
 * LISTEN_REMOVAL_CONFIRMED set if it should go ahead. `activeWidget` is the id of the widget recording or being
 * transcribed, if any.
 */
export const ListenRemovalGuard = Extension.create<{
  activeWidget: () => string | null;
  onBlocked: (tr: Transaction, removal: ListenRemoval) => void;
}>({
  name: "listenRemovalGuard",

  addOptions() {
    return { activeWidget: () => null, onBlocked: () => {} };
  },

  addProseMirrorPlugins() {
    const { activeWidget, onBlocked } = this.options;
    return [
      new Plugin({
        key: new PluginKey("listenRemovalGuard"),
        filterTransaction: (tr) => {
          if (!tr.docChanged || tr.getMeta(LISTEN_REMOVAL_CONFIRMED)) return true;
          const before = listenWidgets(tr.before);
          if (!before.size) return true;
          const after = listenWidgets(tr.doc);
          const removed = [...before.values()].filter((data) => !after.has(data.id));
          const active = activeWidget();
          const removal: ListenRemoval | null = removed.some((data) => data.id === active)
            ? "active"
            : removed.some((data) => data.status === "completed")
              ? "recorded"
              : null;
          if (!removal) return true;
          onBlocked(tr, removal);
          return false;
        },
      }),
    ];
  },
});

/**
 * Keeps `widgetRef` on the id of the widget recording or being transcribed (for ListenRemovalGuard's `activeWidget`),
 * so the editor holding it needn't re-render as the recording's clock ticks.
 */
export function ActiveListenWidget({ widgetRef }: { widgetRef: MutableRefObject<string | null> }) {
  const { status, busy } = useVoiceRecording();
  widgetRef.current = busy ? status.widget_id : null;
  return null;
}

/**
 * Asks before removing a listen widget that's recording, or holds a recording. Escape (or a click outside) keeps it.
 * `onRemove` removes it (false if it couldn't be), and a recording it was making is then stopped (its transcript
 * isn't kept).
 */
export function ListenRemovalDialog({
  removal,
  onKeep,
  onRemove,
}: {
  removal: ListenRemoval;
  onKeep: () => void;
  onRemove: () => boolean;
}) {
  const voice = useVoiceRecording();
  const active = removal === "active";
  const remove = () => {
    if (!onRemove() || !active || !voice.status.is_recording) return;
    void voice.stop().then((result) => result && voice.takeResult(result.id));
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={onKeep}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="listen-removal-title"
        aria-describedby="listen-removal-text"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onKeep();
          }
        }}
        className="panel flex w-[480px] animate-dialog-in flex-col gap-3"
      >
        <h2 id="listen-removal-title" className="flex items-center gap-2 text-base font-semibold">
          {active && <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />}
          {active ? "Voice recording is currently active" : "Remove recording widget?"}
        </h2>
        <p id="listen-removal-text" className="text-[15px] text-text-secondary">
          {active
            ? "The widget is still listening. Removing it will interrupt the recording and all recording will be lost. Do you want to proceed?"
            : "This note contains recorded meeting audio and transcript. Removing it will delete the recording from the note. Do you want to proceed?"}
        </p>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn border-red-500/60 text-red-500 hover:bg-red-500/10" onClick={remove}>
            {active ? "Interrupt & Remove" : "Remove"}
          </button>
          <button type="button" className="btn-primary" autoFocus onClick={onKeep}>
            Keep Widget
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The listen block (see noteFormatting) shown as its widget in the editor. The widget owns its events (its inputs and
 * buttons), so the editor neither selects nor types on them; its data is written back into the node's `data`.
 */
export const ListenNode = ListenBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ListenNodeView, { stopEvent: () => true });
  },
});

function ListenNodeView({ node, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
  return (
    <NodeViewWrapper className="listen-node">
      <ListenWidget
        value={data}
        onChange={(next) => {
          const json = JSON.stringify(next);
          if (json !== data) updateAttributes({ data: json });
        }}
        onRemove={deleteNode}
        selected={selected}
      />
    </NodeViewWrapper>
  );
}
