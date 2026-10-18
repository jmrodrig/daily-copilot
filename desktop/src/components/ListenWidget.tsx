import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import {
  formatClock,
  useVoiceRecording,
  type ListenData,
  type ListenParticipant,
  type VoiceSource,
} from "../context/VoiceRecordingContext";
import { message, promptCopilot, sendJson } from "../lib/api";
import { clientAudioUnavailable, listClientAudioInputs, type ClientAudioInput } from "../lib/clientAudio";
import { notifyNoteUpdated } from "../lib/notes";
import { announcePeopleChange, ASSIGNEE_MAX, Avatar, byName, PersonBadge, usePeople, type Person } from "../lib/people";
import { notePath, useSpace } from "../lib/space";
import { ListenBlock } from "./noteFormatting";
import Popover from "./Popover";

const SOURCES: { value: VoiceSource; label: string }[] = [
  { value: "mic", label: "Default microphone" },
  { value: "loopback", label: "System audio (Teams / calls)" },
  { value: "mixed", label: "Mixed (microphone + system audio)" },
];

/** A choice of the audio source picker: what to record, from which microphone of this machine (its default when null). */
type SourceOption = { key: string; source: VoiceSource; label: string; micDeviceId: string | null };

/**
 * The audio source picker's choices: the default microphone, each microphone of the machine the app is used on (the
 * browser lists them, named once the page may use the microphone), its system audio, and both mixed.
 */
function sourceOptions(inputs: ClientAudioInput[]): SourceOption[] {
  const [mic, loopback, mixed] = SOURCES;
  return [
    { key: mic.value, source: mic.value, label: mic.label, micDeviceId: null },
    ...inputs.map((d) => ({ key: `mic:${d.deviceId}`, source: "mic" as const, label: d.label, micDeviceId: d.deviceId })),
    { key: loopback.value, source: loopback.value, label: loopback.label, micDeviceId: null },
    { key: mixed.value, source: mixed.value, label: mixed.label, micDeviceId: null },
  ];
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
 * A note's listen widget: pick what to record (a microphone, a call's system audio, or both, of the machine the app is
 * used on: the browser records it, see clientAudio) and start listening; on Stop the recording is uploaded, the backend
 * transcribes it offline (Whisper) and works out who spoke (speaker embeddings), and the widget
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
  const [inputs, setInputs] = useState<ClientAudioInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // This machine's microphones to pick from, while there's a recording to make: listed again as they're plugged in
  // or out, and once a recording's started (the browser only names them once the page may use the microphone).
  const canRecord = interactive && Boolean(data) && data?.status !== "completed";
  const recordingNow = status.is_recording;
  useEffect(() => {
    if (!canRecord || clientAudioUnavailable()) return;
    let live = true;
    const list = () =>
      listClientAudioInputs().then(
        (found) => live && setInputs(found),
        () => {}, // Not listed: the default microphone, system audio and mixed are still offered.
      );
    void list();
    navigator.mediaDevices.addEventListener?.("devicechange", list);
    return () => {
      live = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", list);
    };
  }, [canRecord, recordingNow]);
  const options = useMemo(() => sourceOptions(inputs), [inputs]);
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
      const { source, micDeviceId } = picked;
      if (data.source !== source && onChange) onChange({ ...data, source });
      await voice.start({ widgetId: id, source, spaceId: note.spaceId, notePath: note.path, micDeviceId });
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
        {/* Removing a widget that's recording, or holds a recording, asks first (see WidgetRemovalGuard). */}
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
            {note && interactive && clientAudioUnavailable() && (
              <span className="text-xs text-text-muted">{clientAudioUnavailable()}</span>
            )}
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
  const tagged = participants.filter((p) => p.is_tagged);
  const untagged = participants.filter((p) => !p.is_tagged);
  // The space's People: who to name a speaker as, and the avatars of those named.
  const people = usePeople(note?.spaceId ?? 1);
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

      {tagged.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="font-mono text-xs uppercase tracking-[0.06em] text-text-muted">Participants:</span>
          {tagged.map((p) => (
            <TaggedParticipant
              key={p.speaker_id}
              data={data}
              participant={p}
              people={people}
              interactive={interactive}
              note={note}
              onTagged={onTagged}
            />
          ))}
        </div>
      )}

      {untagged.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.06em] text-text-muted">Unidentified speakers</span>
          {untagged.map((p) => (
            <UntaggedParticipant
              key={p.speaker_id}
              data={data}
              participant={p}
              people={people}
              interactive={interactive}
              note={note}
              onTagged={onTagged}
            />
          ))}
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

/** The person of the space's People named `name` (in any case), if any. */
function findPerson(people: Person[], name: string): Person | undefined {
  const needle = name.trim().toLowerCase();
  return needle ? people.find((p) => p.name.toLowerCase() === needle) : undefined;
}

/** A speaker's snippet player: plays it (stopping when unmounted), reporting a failure through `onError`. */
function useSnippet(url: string | null | undefined, onError: (error: string) => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audioRef.current?.pause(), []);
  return function play() {
    if (!url) return;
    audioRef.current?.pause();
    audioRef.current = new Audio(url);
    void audioRef.current.play().catch((err: unknown) => onError(`Could not play the snippet (${message(err)}).`));
  };
}

/**
 * A named speaker, as a chip of the participants' row: their avatar if they're in People, their email on hover. When
 * `interactive`, clicking it opens a popover to hear their snippet, name them as someone else, or remove their tag.
 */
function TaggedParticipant({
  data,
  participant,
  people,
  interactive,
  note,
  onTagged,
}: {
  data: ListenData;
  participant: ListenParticipant;
  people: Person[];
  interactive: boolean;
  note: { spaceId: number; path: string } | null;
  onTagged: (data: ListenData, writtenToNote: boolean) => void;
}) {
  const person = findPerson(people, participant.display_name);
  const email = participant.email || person?.email || null;
  const spaceId = note?.spaceId ?? 1;
  const [editing, setEditing] = useState(false);
  const picker = usePeoplePicker(people, spaceId);
  const play = useSnippet(participant.snippet_url, picker.setError);
  const chip = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const content = (
    <>
      {person ? <Avatar person={person} size="h-4 w-4 shrink-0 rounded-full" textClass="text-[8px]" /> : <span aria-hidden>✓</span>}
      {participant.display_name}
    </>
  );
  const chipClass =
    "inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[13px] text-emerald-400";
  const hover = email ? `${participant.display_name} <${email}>` : participant.display_name;
  if (!interactive) {
    return (
      <span title={hover} className={chipClass}>
        {content}
      </span>
    );
  }

  function open() {
    picker.reset(participant.display_name, person ?? null);
    setEditing(true);
  }

  function close() {
    setEditing(false);
    chip.current?.focus();
  }

  async function post(path: string, body: Record<string, unknown>) {
    picker.setBusy(true);
    picker.setError(null);
    try {
      const response = await sendJson<{ block: ListenData; note_updated: boolean }>("POST", path, {
        speaker_id: participant.speaker_id,
        block: data,
        widget_id: data.id,
        space_id: spaceId,
        note_path: note?.path ?? null,
        ...body,
      });
      setEditing(false);
      onTagged(response.block, response.note_updated);
    } catch (err) {
      picker.setError(message(err));
    } finally {
      picker.setBusy(false);
    }
  }

  /** Names the speaker as the person picked instead (enrolling their voice under that person). */
  async function update() {
    picker.setError(null);
    let next: Person | null;
    try {
      next = await picker.resolve();
    } catch (err) {
      return picker.setError(message(err));
    }
    if (!next) return;
    if (next.name === participant.display_name) return close();
    await post("/api/voice/tag-participant", {
      alias: next.name,
      email: next.email,
      audio_stem: participant.audio_stem ?? null,
      cluster_id: participant.cluster_id ?? null,
    });
  }

  const unchanged = picker.query.trim() === participant.display_name;
  return (
    <span className="inline-flex">
      <button
        ref={chip}
        type="button"
        title={`${hover}: click to edit speaker tagging`}
        aria-haspopup="dialog"
        aria-expanded={editing}
        onClick={() => (editing ? close() : open())}
        className={`${chipClass} cursor-pointer hover:border-emerald-500/70 hover:bg-emerald-500/20`}
      >
        {content}
        <PencilIcon />
      </button>
      <Popover
        anchor={chip}
        open={editing}
        onClose={() => setEditing(false)}
        role="dialog"
        label={`Edit speaker ${participant.display_name}`}
        className="max-w-sm p-3"
      >
        <form
          aria-labelledby={titleId}
          className="flex w-72 flex-col gap-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void update();
          }}
        >
          <div id={titleId}>
            <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">Edit speaker</div>
            <div className="text-[14px] text-text-primary">{participant.display_name}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title={participant.snippet_url ? "Play a snippet of their voice" : "No snippet: they were recognised by their voiceprint"}
              aria-label={`Play a snippet of ${participant.display_name}`}
              disabled={!participant.snippet_url}
              onClick={play}
              className="btn min-h-8 px-2"
            >
              <PlayIcon />
            </button>
            {participant.sample_text && <span className="truncate text-xs italic text-text-muted">“{participant.sample_text}”</span>}
          </div>
          <PeoplePicker picker={picker} label={`Who ${participant.display_name} is`} inline autoFocus />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="btn mr-auto min-h-8 px-2.5 text-[14px]"
              disabled={picker.busy}
              onClick={() => void post("/api/voice/untag-participant", {})}
            >
              Remove tag
            </button>
            <button type="button" className="btn min-h-8 px-2.5 text-[14px]" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary min-h-8 px-3 text-[14px]"
              disabled={picker.busy || !picker.query.trim() || unchanged}
            >
              {picker.busy ? "Saving…" : "Update"}
            </button>
          </div>
          {picker.error && <p className="text-xs text-accent">{picker.error}</p>}
        </form>
      </Popover>
    </span>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="opacity-60">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** One choice of a speaker's People picker: a person, or the typed name to add to People. */
type SpeakerChoice = { key: string; person: Person } | { key: "new"; name: string };

/** The choices for what's typed: the People whose name or email has it, then (unless it's someone's name) adding it. */
function speakerChoices(people: Person[], typed: string): SpeakerChoice[] {
  const name = typed.trim().slice(0, ASSIGNEE_MAX);
  const needle = name.toLowerCase();
  const matching = [...people]
    .sort(byName)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.email ?? "").toLowerCase().includes(needle));
  return [
    ...matching.map((person) => ({ key: `p${person.id}`, person })),
    ...(name && !findPerson(people, name) ? [{ key: "new" as const, name }] : []),
  ];
}

/** The state of a speaker's People picker: what's typed, the person picked, and adding a typed name to People. */
function usePeoplePicker(people: Person[], spaceId: number) {
  const [query, setQuery] = useState("");
  // The person picked (or added); typing again drops it.
  const [selected, setSelected] = useState<Person | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => speakerChoices(people, query), [people, query]);

  function choose(person: Person) {
    setSelected(person);
    setQuery(person.name);
    setOpen(false);
  }

  /** Adds a name to the space's People, telling every People list to reload. */
  async function addPerson(name: string): Promise<Person> {
    const person = await sendJson<Person>("POST", "/api/people", { space_id: spaceId, name, is_external: false });
    announcePeopleChange();
    return person;
  }

  /** Picks a choice: a person, or adds the typed name to People and picks them. */
  async function pick(choice: SpeakerChoice) {
    if ("person" in choice) return choose(choice.person);
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      choose(await addPerson(choice.name));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  /** Who to name the speaker as: the person picked, else the one named as typed, else the typed name added to People. */
  async function resolve(): Promise<Person | null> {
    const typed = query.trim().slice(0, ASSIGNEE_MAX);
    if (!selected && !typed) return null;
    setOpen(false);
    let person = selected ?? findPerson(people, typed);
    if (!person) {
      person = await addPerson(typed);
      choose(person); // So naming them again, if it fails, doesn't add them twice.
    }
    return person;
  }

  /** Starts over from `name` (and the person of that name, if any). */
  function reset(name: string, person: Person | null) {
    setQuery(name);
    setSelected(person);
    setHighlight(0);
    setOpen(false);
    setError(null);
  }

  return {
    query,
    setQuery,
    selected,
    setSelected,
    open,
    setOpen,
    highlight,
    setHighlight,
    busy,
    setBusy,
    error,
    setError,
    choices,
    pick,
    resolve,
    reset,
  };
}

/**
 * A combobox of the space's People, filtered by name or email as typed, with adding the typed name to People as its
 * last choice. Its list floats in a popover, or with `inline`, opens under it (when it's in a popover itself).
 */
function PeoplePicker({
  picker,
  label,
  inline = false,
  autoFocus = false,
}: {
  picker: ReturnType<typeof usePeoplePicker>;
  label: string;
  inline?: boolean;
  autoFocus?: boolean;
}) {
  const { query, setQuery, selected, setSelected, open, setOpen, highlight, setHighlight, busy, choices, pick } = picker;
  const anchor = useRef<HTMLDivElement>(null);
  const listId = useId();
  const listOpen = open && choices.length > 0;

  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (choices.length ? (h + step + choices.length) % choices.length : 0));
    } else if (e.key === "Enter" && open && choices[highlight]) {
      // Picks rather than submitting the form; the next Enter submits.
      e.preventDefault();
      void pick(choices[highlight]);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  const options = choices.map((choice, index) => (
    <div
      key={choice.key}
      id={`${listId}-${choice.key}`}
      role="option"
      aria-selected={"person" in choice && choice.person.id === selected?.id}
      // Keep the focus in the input while picking.
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setHighlight(index)}
      onClick={() => void pick(choice)}
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
        index === highlight ? "bg-surface-raised text-text-primary" : "text-text-secondary"
      }`}
    >
      {"person" in choice ? (
        <>
          <PersonBadge person={choice.person} />
          {choice.person.email && <span className="truncate text-xs text-text-muted">{choice.person.email}</span>}
        </>
      ) : (
        <span className="truncate text-accent-soft">+ Add “{choice.name}” to People</span>
      )}
    </div>
  ));

  const field = (
    <div ref={anchor} className="relative flex items-center">
      {selected && (
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
          <Avatar person={selected} size="h-5 w-5 shrink-0 rounded-full" textClass="text-[9px]" />
        </span>
      )}
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && choices[highlight] ? `${listId}-${choices[highlight].key}` : undefined}
        placeholder="Pick or add a person"
        value={query}
        maxLength={ASSIGNEE_MAX}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={busy}
        onFocus={() => {
          setHighlight(0);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={keys}
        className={`field py-1.5 ${inline ? "w-full" : "w-56"} ${selected ? "pl-8" : ""}`}
      />
      {!inline && (
        <Popover anchor={anchor} open={listOpen} onClose={() => setOpen(false)} id={listId} label={label}>
          {options}
        </Popover>
      )}
    </div>
  );
  if (!inline) return field;
  return (
    <div className="flex flex-col gap-1">
      {field}
      {listOpen && (
        <div id={listId} role="listbox" aria-label={label} className="max-h-40 overflow-y-auto rounded-md border border-border-default p-1">
          {options}
        </div>
      )}
    </div>
  );
}

/**
 * A speaker who wasn't recognised: play their snippet, pick who they are from the space's People (or add them to it),
 * and enrol their voice under that person's name and email.
 */
function UntaggedParticipant({
  data,
  participant,
  people,
  interactive,
  note,
  onTagged,
}: {
  data: ListenData;
  participant: ListenParticipant;
  people: Person[];
  interactive: boolean;
  note: { spaceId: number; path: string } | null;
  onTagged: (data: ListenData, writtenToNote: boolean) => void;
}) {
  const spaceId = note?.spaceId ?? 1;
  const picker = usePeoplePicker(people, spaceId);
  const { busy: saving, setBusy: setSaving, error, setError } = picker;
  const play = useSnippet(participant.snippet_url, setError);

  /** Names the speaker as the picked person (else the one named as typed, else adds the typed name to People). */
  async function tag() {
    setSaving(true);
    setError(null);
    try {
      const person = await picker.resolve();
      if (!person) return;
      const response = await sendJson<{ block: ListenData; note_updated: boolean }>("POST", "/api/voice/tag-participant", {
        speaker_id: participant.speaker_id,
        alias: person.name,
        email: person.email,
        audio_stem: participant.audio_stem ?? null,
        cluster_id: participant.cluster_id ?? null,
        block: data,
        widget_id: data.id,
        space_id: spaceId,
        note_path: note?.path ?? null,
      });
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
            <PeoplePicker picker={picker} label={`Name of ${participant.display_name}`} />
            <button type="submit" className="btn-primary min-h-8 px-3 text-[14px]" disabled={saving || !picker.query.trim()}>
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

/**
 * Keeps `widgetRef` on the id of the widget recording or being transcribed (for WidgetRemovalGuard's `activeWidget`),
 * so the editor holding it needn't re-render as the recording's clock ticks.
 */
export function ActiveListenWidget({ widgetRef }: { widgetRef: MutableRefObject<string | null> }) {
  const { status, busy } = useVoiceRecording();
  widgetRef.current = busy ? status.widget_id : null;
  return null;
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
