import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import { createPortal } from "react-dom";
import { Link, useBlocker, useNavigate, useSearchParams, type Blocker } from "react-router-dom";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import { formatDay, LABEL_TAG, NEUTRAL_TAG, ProjectTag, Tag, TagPills } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { isLocalHref, openLocalFile } from "../lib/localFiles";
import { useNoteUpdates } from "../lib/notes";
import { notePath, openNoteInNewWindow, useSpace } from "../lib/space";
import { useTitle } from "../lib/title";
import { isOverdue, STATUS_LABELS, taskIdFromHref, useTaskChanges, useTaskPanel, type TaskItem } from "../lib/tasks";
import MediaLightbox, { ExpandButton, isPdfUrl, MarkupOverlay } from "../components/MediaLightbox";
import NoteHistoryModal, { type RestoredNote } from "../components/NoteHistoryModal";
import { isTyping } from "../components/markupCore";
import NoteEditor from "../components/NoteEditor";
import { AssigneeTag, PillIcon, refKind, StatusTag, useTaskInfo } from "../components/referencePill";
import { NOTE_COLUMN, NOTE_HTML_SCHEMA, copyCleanSelection, layoutMedia, liftCellColors } from "../components/noteFormatting";
import WhiteboardView from "../components/WhiteboardView";
import { COLLAPSE_ICON, EXPAND_ICON, WhiteboardFrame } from "../components/WhiteboardWidget";
import { Segment, ToolIcon } from "../components/markupUi";
import ListenWidget from "../components/ListenWidget";
import { useVoiceRecording } from "../context/VoiceRecordingContext";

// GET /api/notes/file (see NoteFile in backend/schemas.py).
type NoteFile = { path: string; frontmatter: Record<string, unknown>; content: string };
type State = { state: "loading" } | { state: "ok"; note: NoteFile } | { state: "error"; message: string };
// The `state` front-matter: drafts are edited here, published notes are read-only. Notes without it are published.
type NoteState = "draft" | "published";

const noteState = (frontmatter: Record<string, unknown>): NoteState =>
  frontmatter.state === "draft" ? "draft" : "published";

/** A `type: whiteboard` note is a whiteboard page: its body is the board's JSON (see whiteboard.ts), not markdown. */
const isWhiteboardNote = (frontmatter: Record<string, unknown>) => frontmatter.type === "whiteboard";

// Front-matter keys that aren't listed: the title is the heading, the tags are pills in the header, and
// priorities belong to tasks, not notes. (A whiteboard's `type` isn't listed either: it shows in how it's laid out.)
const HIDDEN_PROPS = new Set(["title", "tags", "priority"]);

// A draft is saved once it's been left alone this long (ms).
const AUTO_SAVE_DELAY = 2000;

/** The note's `title` front-matter, or else its file name. */
const noteTitle = (frontmatter: Record<string, unknown>, path: string): string =>
  typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : (path.split("/").pop() ?? "").replace(/\.md$/i, "");

/** The `tags` front-matter, a list or a single tag, without blanks or repeats. */
const noteTags = (frontmatter: Record<string, unknown>): string[] => {
  const raw = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
  return [...new Set(raw.filter((t) => typeof t === "string" || typeof t === "number").map((t) => String(t).trim()))].filter(Boolean);
};

function show(value: unknown): string {
  // ISO timestamps (`2026-10-02T22:46:19`) read as `2026-10-02 22:46`.
  if (typeof value === "string") return value.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, "$1 $2");
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * A note or template (`/note?space=1&path=...[&root=templates]`). A draft note is edited in place, saved as it's
 * edited, and published when done; a published note (and a template) is read-only here, so click Edit or ask the
 * Co-pilot to change it. A whiteboard note (`type: whiteboard`) fills the page with its board instead of a document,
 * drawn on while it's a draft and read-only once published, saved the same way.
 */
export default function NotePage() {
  const [params] = useSearchParams();
  const { spaceId: activeSpaceId, refreshTree } = useSpace();
  const navigate = useNavigate();
  const path = params.get("path") ?? "";
  const spaceId = Number(params.get("space") ?? activeSpaceId);
  const isTemplate = params.get("root") === "templates";
  const [note, setNote] = useState<State>({ state: "loading" });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [body, setBody] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  // An auto-save or Ctrl+S ("content") keeps the draft editable; publishing or editing a note ("state") doesn't.
  const [saving, setSaving] = useState<"content" | "state" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A new title already taken by another note in the folder (HTTP 409): asks for a different one.
  const [collision, setCollision] = useState<{ conflictingTitle: string } | null>(null);
  // Tags are saved on their own, straight away; the body's auto-save waits for them.
  const [savingTags, setSavingTags] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  // A whiteboard page's board, filling the window (over the sidebar and the page) till Escape or its button.
  const [boardFullscreen, setBoardFullscreen] = useState(false);
  useEffect(() => setBoardFullscreen(false), [path]);
  // The version history, over the page; and the message shown once a version's been restored.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoredToast, setRestoredToast] = useState<string | null>(null);
  useEffect(() => {
    setHistoryOpen(false);
    setRestoredToast(null);
  }, [path, spaceId, isTemplate]);
  // Counted up as a version's restored, so the editor (which only reads its value as it mounts) loads it afresh.
  const [restores, setRestores] = useState(0);
  // The title and body that last failed to save: auto-save waits for another edit rather than retrying them.
  const failedRef = useRef<string | null>(null);
  // The draft's unsaved changes, saved when the page moves to another note (or closes) before auto-save has.
  const unsavedRef = useRef<{ space_id: number; path: string; content: string; title?: string } | null>(null);
  // The path a save renamed the note to (after its title), followed by the page without loading the note afresh.
  const followedPathRef = useRef<string | null>(null);
  // The path the editor was loaded for: it's remounted for another note, not for this one renamed.
  const [editorPath, setEditorPath] = useState(path);

  // While a listen widget on this note is recording, leaving the note (a link, the sidebar, back or forward) asks
  // first: stay, stop the recording and leave, or open the other page in a new window and keep recording here. The
  // note's own rename, and opening a task beside it, aren't leaving it.
  const voice = useVoiceRecording();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!voice.recordingHere) return false;
    const current = new URLSearchParams(currentLocation.search);
    const next = new URLSearchParams(nextLocation.search);
    const sameNote =
      nextLocation.pathname === currentLocation.pathname &&
      (["path", "space", "root"] as const).every((key) => next.get(key) === current.get(key));
    const followingRename = nextLocation.pathname === "/note" && followedPathRef.current !== null && next.get("path") === followedPathRef.current;
    return !sameNote && !followingRename;
  });
  // The recording ended meanwhile (stopped from the title bar, or another window): carry on where the user was going.
  useEffect(() => {
    if (blocker.state === "blocked" && !voice.recordingHere) blocker.proceed();
  }, [blocker, voice.recordingHere]);

  const [externalChange, setExternalChange] = useState(false);
  useEffect(() => {
    setExternalChange(false);
  }, [path, spaceId, isTemplate]);

  const parts = path.split("/");
  const fm = note.state === "ok" ? note.note.frontmatter : {};
  const title = noteTitle(fm, path);
  useTitle(title);
  // The edited title, saved to the `title` front-matter; a blank one is ignored.
  const newTitle = titleDraft.trim() !== (fm.title || '') ? titleDraft.trim() : null;
  const props = Object.entries(fm).filter(
    ([key, value]) =>
      !HIDDEN_PROPS.has(key) &&
      !(key === "state" && !isTemplate) &&
      !(key === "type" && value === "whiteboard") &&
      value !== null &&
      value !== "",
  );
  const state = isTemplate || note.state !== "ok" ? null : noteState(fm);
  const dirty = note.state === "ok" && (body !== note.note.content || newTitle !== null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftKey = `${titleDraft}\n${body}`;

  // Declared before the loading effect, which clears it for the next note.
  useEffect(() => {
    unsavedRef.current =
      state === "draft" && dirty ? { space_id: spaceId, path, content: body, ...(newTitle !== null && { title: newTitle }) } : null;
  });

  const reloadTasks = useCallback(async () => {
    if (isTemplate || !path) return;
    try {
      const query = new URLSearchParams({ space_id: String(spaceId), note_path: path });
      const loaded = await getJson<TaskItem[]>(`/api/tasks?${query}`);
      setTasks(loaded);
    } catch {
      // ignore
    }
  }, [spaceId, path, isTemplate]);

  const reload = useCallback(async () => {
    if (!path) return;
    const query = new URLSearchParams({ space_id: String(spaceId), path, root: isTemplate ? "templates" : "content" });
    try {
      const loaded = await getJson<NoteFile>(`/api/notes/file?${query}`);
      unsavedRef.current = null;
      failedRef.current = null;
      setSaveError(null);
      setNote({ state: "ok", note: loaded });
      setBody(loaded.content);
      setTitleDraft(noteTitle(loaded.frontmatter, path));
      setRestores((n) => n + 1);
      setExternalChange(false);
      refreshTree();
    } catch {
      // ignore
    }
    void reloadTasks();
  }, [spaceId, path, isTemplate, refreshTree, reloadTasks]);

  useNoteUpdates(spaceId, path, () => {
    if (!dirtyRef.current) {
      void reload();
    } else {
      setExternalChange(true);
    }
  });

  useEffect(() => {
    // Leaving the note: keep the edits auto-save hasn't got to yet.
    const leave = () => {
      const unsaved = unsavedRef.current;
      unsavedRef.current = null;
      if (unsaved) sendJson("PUT", "/api/notes/file", unsaved).then(refreshTree, () => {});
    };
    if (followedPathRef.current === path) {
      followedPathRef.current = null;
      return leave;
    }
    followedPathRef.current = null;
    const controller = new AbortController();
    unsavedRef.current = null;
    setEditorPath(path);
    setNote({ state: "loading" });
    setSaveError(null);
    setTagError(null);
    failedRef.current = null;
    const query = new URLSearchParams({ space_id: String(spaceId), path, root: isTemplate ? "templates" : "content" });
    getJson<NoteFile>(`/api/notes/file?${query}`, controller.signal)
      .then((loaded) => {
        setNote({ state: "ok", note: loaded });
        setBody(loaded.content);
        setTitleDraft(noteTitle(loaded.frontmatter, path));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setNote({ state: "error", message: message(err) });
      });
    return () => {
      controller.abort();
      leave();
    };
  }, [path, spaceId, isTemplate]);

  useEffect(() => {
    setTasks([]);
    if (isTemplate) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ space_id: String(spaceId), note_path: path });
    getJson<TaskItem[]>(`/api/tasks?${query}`, controller.signal)
      .then(setTasks)
      .catch(() => {});
    return () => controller.abort();
  }, [path, spaceId, isTemplate]);

  // Edited in the task panel: update the linked tasks, dropping one that was deleted or linked elsewhere.
  useTaskChanges("board", ({ id, task, deleted }) =>
    setTasks((current) =>
      current.flatMap((t) => (t.id !== id ? [t] : deleted || (task && task.note_path !== path) ? [] : [task ?? t])),
    ),
  );

  // Auto-save: a draft is saved once it's been left alone for a moment. Each edit restarts the wait.
  useEffect(() => {
    if (state !== "draft" || !dirty || saving || savingTags || failedRef.current === draftKey) return;
    const timer = window.setTimeout(() => void save(), AUTO_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [state, dirty, saving, savingTags, draftKey]);

  // The latest `save`, for the key handler.
  const saveRef = useRef(save);
  saveRef.current = save;
  // "e" edits a published note. Not while typing, or with a dialog (the lightbox) open over it.
  useEffect(() => {
    if (state !== "published") return;
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== "e" || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
      if (isTyping(e.target) || document.querySelector("[aria-modal]")) return;
      e.preventDefault();
      void saveRef.current("draft");
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [state]);

  /**
   * Save the draft's title and body and/or switch the note's state (PUT /api/notes/file). `retitle` saves that title
   * in place of the edited one (the collision dialog's pick, before `titleDraft` has caught up).
   */
  async function save(next?: NoteState, retitle?: string) {
    if (note.state !== "ok" || saving || savingTags) return;
    const content = body;
    const draft = retitle ?? titleDraft;
    const savedTitle = state === "draft" && draft.trim() !== (fm.title || "") ? draft.trim() : null;
    setSaving(next ? "state" : "content");
    setSaveError(null);
    failedRef.current = null;
    try {
      const saved = await sendJson<NoteFile>("PUT", "/api/notes/file", {
        space_id: spaceId,
        path,
        ...(state === "draft" && { content }),
        ...(savedTitle !== null && { title: savedTitle }),
        ...(next && { state: next }),
      });
      setNote({ state: "ok", note: saved });
      setExternalChange(false);
      // Edits made while it saved are kept, for the next save.
      setBody((current) => (current === content ? saved.content : current));
      setTitleDraft((current) => (current === draft ? noteTitle(saved.frontmatter, saved.path) : current));
      refreshTree(); // the title may have changed
      if (saved.path !== path) {
        // A new title renamed the file: follow it, keeping the editor (and edits made while it saved) as they are.
        unsavedRef.current = null;
        followedPathRef.current = saved.path;
        navigate(notePath(spaceId, saved.path, isTemplate ? "templates" : "content"), { replace: true });
      }
    } catch (err) {
      const msg = message(err);
      failedRef.current = `${draft}\n${content}`;
      setSaveError(msg);
      if (savedTitle !== null && msg.toLowerCase().includes("already exists")) setCollision({ conflictingTitle: savedTitle });
    } finally {
      setSaving(null);
    }
  }

  /** The collision dialog's pick: save the note under the new title. */
  function renameAfterCollision(name: string) {
    setCollision(null);
    setTitleDraft(name);
    void save(undefined, name);
  }

  /** The collision dialog was dismissed: back to the saved title, with the error cleared. */
  function revertAfterCollision() {
    setCollision(null);
    if (note.state === "ok") setTitleDraft(noteTitle(note.note.frontmatter, note.note.path));
    setSaveError(null);
  }

  /** Replace the note's `tags` front-matter (PUT /api/notes/file), leaving its body and unsaved edits alone. */
  async function saveTags(tags: string[]) {
    if (note.state !== "ok" || saving || savingTags) return;
    setSavingTags(true);
    setTagError(null);
    try {
      const saved = await sendJson<NoteFile>("PUT", "/api/notes/file", { space_id: spaceId, path, tags });
      // Only the front-matter changed on disk: the last saved body stays the baseline for unsaved edits.
      setNote((current) =>
        current.state === "ok" && current.note.path === saved.path
          ? { state: "ok", note: { ...current.note, frontmatter: saved.frontmatter } }
          : current,
      );
    } catch (err) {
      setTagError(message(err));
    } finally {
      setSavingTags(false);
    }
  }

  /** Open the version history, saving the draft's unsaved edits first so they're a version of their own. */
  async function openHistory() {
    if (state === "draft" && dirty) await save();
    setHistoryOpen(true);
  }

  /** A version was restored (POST /api/notes/history/{id}/restore): show it as the note. */
  function restored(saved: RestoredNote) {
    unsavedRef.current = null;
    failedRef.current = null;
    setSaveError(null);
    setNote({ state: "ok", note: saved });
    setBody(saved.content);
    setTitleDraft(noteTitle(saved.frontmatter, path));
    setRestores((n) => n + 1);
    setHistoryOpen(false);
    setRestoredToast(`Restored “${noteTitle(saved.frontmatter, path)}” to an earlier version`);
    refreshTree(); // the title may have changed
  }

  const status =
    state === "draft" ? (
      <div className="flex items-center gap-3">
        {saveError && !saving ? (
          <button type="button" className="btn" onClick={() => save()}>
            Retry save
          </button>
        ) : (
          <span role="status" className="text-xs text-text-muted">
            {saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
          </span>
        )}
        <button type="button" className="btn-primary" onClick={() => save("published")} disabled={saving !== null}>
          Publish
        </button>
      </div>
    ) : state === "published" ? (
      <button type="button" className="btn-primary" onClick={() => save("draft")} disabled={saving !== null}>
        Edit
      </button>
    ) : undefined;
  const whiteboard = note.state === "ok" && isWhiteboardNote(fm);
  // Printing (or saving as PDF from the print dialog) shows just the note; see the print styles in index.css.
  const actions = (
    <div className="flex items-center gap-3 print:hidden">
      {status}
      <button
        type="button"
        className="btn inline-flex items-center gap-1.5"
        onClick={() => void openHistory()}
        disabled={note.state !== "ok" || saving !== null}
        title="Version history"
      >
        <ClockIcon />
        History
      </button>
      <button
        type="button"
        className="btn inline-flex items-center gap-1.5"
        onClick={() => openNoteInNewWindow(spaceId, path, isTemplate ? "templates" : "content")}
        disabled={note.state !== "ok"}
        title="Open this note in a new window"
      >
        <ExternalWindowIcon />
        New window
      </button>
      {!whiteboard && (
        <button type="button" className="btn" onClick={() => window.print()} disabled={note.state !== "ok"}>
          Print / PDF
        </button>
      )}
    </div>
  );

  const tags = noteTags(fm);
  // A note's tags can always be edited, drafts and published notes alike; a template's are only shown.
  const tagsEditable = state !== null;
  const details =
    props.length > 0 || tasks.length > 0 || tags.length > 0 || tagsEditable ? (
      <>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          {props.length > 0 && (
            <dl className="contents">
              {props.map(([key, value]) => (
                <div key={key} className="flex gap-1.5">
                  <dt className="text-text-muted">{key}</dt>
                  <dd className="text-text-secondary">{show(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {tagsEditable ? (
            <NoteTags spaceId={spaceId} tags={tags} onChange={saveTags} disabled={saving !== null || savingTags} />
          ) : (
            tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <TagPills tags={tags} />
              </div>
            )
          )}
        </div>
        {tagError && <p className="-mt-3 print:hidden text-[15px] text-accent">Could not update the tags ({tagError}).</p>}
        {tasks.length > 0 && <LinkedTasks tasks={tasks} />}
      </>
    ) : null;

  const breadcrumb = (
    <div className="flex min-w-0 items-center gap-3">
      <span className="truncate font-mono text-xs tracking-[0.06em] text-text-muted">
        {isTemplate ? "TEMPLATE" : parts.slice(0, -1).join(" / ").toUpperCase() || "NOTES"}
      </span>
      {whiteboard && <Tag className={NEUTRAL_TAG}>whiteboard</Tag>}
      {state && <Tag className={state === "draft" ? DRAFT_TAG : NEUTRAL_TAG}>{state}</Tag>}
    </div>
  );

  const overlays = (
    <>
      {historyOpen && note.state === "ok" && (
        <NoteHistoryModal
          spaceId={spaceId}
          path={path}
          isTemplate={isTemplate}
          title={title}
          current={note.note}
          renderPreview={(version) =>
            isWhiteboardNote(version.frontmatter) ? (
              <WhiteboardFrame value={version.content.trim()} editable={false} />
            ) : (
              <NoteMarkdown content={version.content} preview />
            )
          }
          onRestored={restored}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {collision && (
        <CollisionDialog
          conflictingTitle={collision.conflictingTitle}
          onRename={renameAfterCollision}
          onCancel={revertAfterCollision}
        />
      )}
      {restoredToast && <RestoredToast label={restoredToast} onClose={() => setRestoredToast(null)} />}
      {blocker.state === "blocked" && (
        <LeaveRecordingDialog
          onStay={() => blocker.reset()}
          onStopAndLeave={() => {
            // The backend finishes the transcript and writes it into the note on its own.
            void voice.stop();
            blocker.proceed();
          }}
          onOpenInNewWindow={() => openBlockedInNewWindow(blocker)}
        />
      )}
    </>
  );

  if (whiteboard && note.state === "ok") {
    const editable = state === "draft" && saving !== "state";
    return (
      // The board takes the rest of the page's height, under the title, the actions and the properties.
      <div className="flex h-full min-h-[560px] w-full flex-col gap-3 px-9 py-5">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-4">
          {breadcrumb}
          {actions}
        </div>
        {externalChange && (
          <div className="flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200 print:hidden">
            <span>Co-pilot updated this note on disk.</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-100 hover:bg-amber-500/30"
              >
                Reload to view changes
              </button>
              <button
                type="button"
                onClick={() => setExternalChange(false)}
                className="text-amber-300 hover:text-white"
                title="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {saveError && <p className="text-[15px] text-accent">Could not save {path} ({saveError}).</p>}
        {state === "draft" ? (
          <input
            aria-label="Title"
            placeholder="Untitled"
            value={titleDraft}
            disabled={!editable}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (dirty) void save();
              }
            }}
            className="w-full bg-transparent text-[26px] font-semibold leading-tight text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        ) : (
          <h1 className="text-[26px] font-semibold leading-tight">{title}</h1>
        )}
        {details && <div className="flex flex-col gap-3">{details}</div>}
        <WhiteboardView
          key={`${editorPath}:${restores}`}
          value={body}
          onChange={setBody}
          editable={editable}
          spaceId={spaceId}
          captureWheel
          onSave={() => dirty && void save()}
          // Fullscreen in place (not a remount), so the board keeps its view and its Undo.
          onEscape={boardFullscreen ? () => setBoardFullscreen(false) : undefined}
          toolbarEnd={
            <Segment
              on={false}
              label={boardFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              onClick={() => setBoardFullscreen(!boardFullscreen)}
            >
              <ToolIcon path={boardFullscreen ? COLLAPSE_ICON : EXPAND_ICON} />
            </Segment>
          }
          className={
            boardFullscreen
              ? "fixed inset-0 z-50"
              : "min-h-[360px] flex-1 rounded-lg border border-border-default"
          }
        />
        {overlays}
      </div>
    );
  }

  return (
    // The page fills the canvas, so the editor's toolbar spans it; the note sits in a centered text column, out of
    // which resized images and tables can break.
    <div className="flex w-full flex-col gap-5 px-9 py-7 print:gap-4 print:p-0">
      {/* Breadcrumb and actions sit above the document, so the title reads as its first line. */}
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-4 print:hidden">
        {breadcrumb}
        {actions}
      </div>
      {externalChange && (
        <div className={`${NOTE_COLUMN} flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200 print:hidden`}>
          <span>Co-pilot updated this note on disk.</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reload()}
              className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-100 hover:bg-amber-500/30"
            >
              Reload to view changes
            </button>
            <button
              type="button"
              onClick={() => setExternalChange(false)}
              className="text-amber-300 hover:text-white"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {saveError && <p className={`${NOTE_COLUMN} text-[15px] print:hidden text-accent`}>Could not save {path} ({saveError}).</p>}
      {state === "draft" && note.state === "ok" ? (
        // The editor's toolbar sits above the title, which is edited in place, and the properties.
        <NoteEditor
          key={`${editorPath}:${restores}`}
          spaceId={spaceId}
          notePath={path}
          onTaskCreated={(task) => task.note_path === path && setTasks((current) => [...current, task])}
          title={titleDraft}
          onTitleChange={setTitleDraft}
          value={body}
          onChange={setBody}
          onSave={() => dirty && save()}
          disabled={saving === "state"}
        >
          {details}
        </NoteEditor>
      ) : (
        <>
          <h1 className={`${NOTE_COLUMN} -mb-2 text-[33px] font-semibold leading-tight`}>{title}</h1>
          {note.state === "loading" && <p className={`${NOTE_COLUMN} text-[15px] text-text-muted`}>Loading…</p>}
          {note.state === "error" && <p className={`${NOTE_COLUMN} text-[15px] text-text-secondary`}>Could not open {path} ({note.message}).</p>}
          {note.state === "ok" && (
            <>
              {details && <div className={`${NOTE_COLUMN} flex flex-col gap-5`}>{details}</div>}
              <NoteMarkdown content={note.note.content} />
            </>
          )}
        </>
      )}
      {overlays}
    </div>
  );
}

/** A note's body as the read-only page shows it (and, as a `preview`, the version history: its widgets only show). */
function NoteMarkdown({ content, preview = false }: { content: string; preview?: boolean }) {
  return (
    <article className="note-body markdown text-[16px] leading-relaxed text-text-secondary" onCopy={copyCleanSelection}>
      {/* Inline HTML carries text and cell colors, alignment and image and table sizes; anything else in it is stripped. */}
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, NOTE_HTML_SCHEMA], liftCellColors, layoutMedia, rehypeKatex]}
        components={preview ? PREVIEW_COMPONENTS : NOTE_COMPONENTS}
        urlTransform={noteUrlTransform}
      >
        {content}
      </Markdown>
    </article>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function ExternalWindowIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 8 8" />
      <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

/** Open where the blocked navigation was going in a new window, staying on this note (and its recording). */
function openBlockedInNewWindow(blocker: Blocker) {
  if (blocker.state !== "blocked") return;
  const { pathname, search, hash } = blocker.location;
  window.open(`${window.location.origin}${pathname}${search}${hash}`, "_blank", "noopener,noreferrer");
  blocker.reset();
}

/** Asks before leaving a note whose listen widget is recording. Escape (or a click outside) stays. */
function LeaveRecordingDialog({
  onStay,
  onStopAndLeave,
  onOpenInNewWindow,
}: {
  onStay: () => void;
  onStopAndLeave: () => void;
  onOpenInNewWindow: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={onStay}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-recording-title"
        aria-describedby="leave-recording-text"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onStay();
          }
        }}
        className="panel flex w-[480px] animate-dialog-in flex-col gap-3"
      >
        <h2 id="leave-recording-title" className="flex items-center gap-2 text-base font-semibold">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
          Voice recording is active
        </h2>
        <p id="leave-recording-text" className="text-[15px] text-text-secondary">
          Voice recording is active on this note. Leaving this note will stop listening and finalize the transcription.
        </p>
        <p className="text-xs text-text-muted">Tip: Open the new view in a new window to keep recording.</p>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onOpenInNewWindow}>
            Open in New Window
          </button>
          <button type="button" className="btn border-red-500/60 text-red-500 hover:bg-red-500/10" onClick={onStopAndLeave}>
            Stop &amp; Leave
          </button>
          <button type="button" className="btn-primary" autoFocus onClick={onStay}>
            Stay on Page
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// How long the "restored" message stays up (ms).
const TOAST_DURATION = 4000;

/** Asks for a different title when the one given is taken by another note in the folder. */
function CollisionDialog({
  conflictingTitle,
  onRename,
  onCancel,
}: {
  conflictingTitle: string;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(conflictingTitle);
  const clean = name.trim();
  const canRename = clean !== "" && clean !== conflictingTitle;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canRename) onRename(clean);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Name already taken"
        className="panel flex w-[420px] flex-col gap-3"
      >
        <h2 className="text-base font-semibold">Name already taken</h2>
        <p className="text-xs text-text-muted">
          A note named "{conflictingTitle}" already exists in this folder. Please choose a different name.
        </p>
        <input
          autoFocus
          aria-label="New title"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          className="field"
        />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            Revert to original
          </button>
          <button type="submit" className="btn-primary" disabled={!canRename}>
            Rename
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** The message that a version's been restored, at the foot of the window till it times out or is dismissed. */
function RestoredToast({ label, onClose }: { label: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, TOAST_DURATION);
    return () => window.clearTimeout(timer);
  }, [label]);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 animate-toast-in items-center gap-3 rounded-xl border border-border-default bg-surface-raised py-2 pl-4 pr-2 text-[13px] shadow-xl print:hidden"
    >
      <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
        <path d="M2.5 7.5l3 3 6-7" />
      </svg>
      <span className="max-w-[420px] truncate text-text-primary">{label}</span>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary">
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}

const DRAFT_TAG = "border-accent/60 text-accent";

/**
 * A note's tags as `#tag` pills (project codes in their project's color): hovering a pill shows an × that removes
 * it, and "+ Add tag" opens an inline input (Enter adds, Escape closes). While typing, a dropdown suggests the
 * space's existing tags (arrows move through it, Enter picks the highlighted one). Each change is saved through
 * `onChange`.
 */
function NoteTags({
  spaceId,
  tags,
  onChange,
  disabled,
}: {
  spaceId: number;
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
}) {
  const { projects } = useSpace();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  // The highlighted suggestion, or -1 for none (Enter then adds the typed tag).
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!adding) return;
    const controller = new AbortController();
    getJson<string[]>(`/api/spaces/${spaceId}/tags`, controller.signal)
      .then(setKnown)
      .catch(() => {}); // Suggestions are a convenience; typing a tag still works without them.
    return () => controller.abort();
  }, [adding, spaceId]);

  const query = draft.trim().replace(/^#+/, "").trim().toLowerCase();
  const taken = new Set(tags.map((t) => t.toLowerCase()));
  const suggestions = query ? known.filter((t) => !taken.has(t.toLowerCase()) && t.toLowerCase().includes(query)) : [];

  function add(tag = draft.trim().replace(/^#+/, "").trim()) {
    setDraft("");
    setActive(-1);
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
  }

  function tagStyle(tag: string) {
    const color = projects.find((p) => p.code.toLowerCase() === tag.toLowerCase())?.color;
    return color ? { className: "", style: { color, borderColor: `${color}99` } } : { className: LABEL_TAG };
  }

  return (
    <div role="group" aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => {
        const { className, style } = tagStyle(tag);
        return (
          <span
            key={tag}
            style={style}
            className={`group inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[12px] leading-4 ${className}`}
          >
            {`#${tag}`}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              title="Remove tag"
              disabled={disabled}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="hidden leading-none text-text-muted hover:text-accent focus-visible:inline group-hover:inline group-focus-within:inline disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}
      {adding ? (
        <div className="relative">
          <input
            autoFocus
            role="combobox"
            aria-label="New tag"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls="note-tag-suggestions"
            aria-activedescendant={active >= 0 ? `note-tag-suggestion-${active}` : undefined}
            placeholder="tag"
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && suggestions.length > 0) {
                e.preventDefault();
                setActive((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                e.preventDefault();
                setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                add(active >= 0 && active < suggestions.length ? suggestions[active] : undefined);
              } else if (e.key === "Escape") {
                setDraft("");
                setActive(-1);
                setAdding(false);
              }
            }}
            onBlur={() => {
              add();
              setAdding(false);
            }}
            className="w-28 rounded border border-border-default bg-transparent print:hidden px-1.5 py-px font-mono text-[12px] leading-4 text-text-primary outline-none focus:border-accent/60"
          />
          {suggestions.length > 0 && (
            <ul
              id="note-tag-suggestions"
              role="listbox"
              aria-label="Existing tags"
              className="absolute left-0 top-full z-20 mt-1 max-h-48 min-w-full overflow-y-auto rounded border border-border-strong bg-surface-active py-0.5 shadow-xl shadow-black/40 print:hidden"
            >
              {suggestions.map((tag, i) => (
                <li
                  key={tag}
                  id={`note-tag-suggestion-${i}`}
                  role="option"
                  aria-selected={i === active}
                  // Picked on mouse down, before the input's blur adds the half-typed draft instead.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(tag);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`cursor-pointer whitespace-nowrap px-2 py-0.5 font-mono text-[12px] leading-4 ${
                    i === active ? "bg-accent/15 text-accent" : "text-text-secondary"
                  }`}
                >
                  {`#${tag}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-border-default px-1.5 print:hidden py-px font-mono text-[12px] leading-4 text-text-muted hover:border-accent/60 hover:text-accent disabled:opacity-50"
        >
          + Add tag
        </button>
      )}
    </div>
  );
}

/**
 * A published note's image, in a box laid out as the image would be (taking its `note-media` class and width) with
 * its markup over it and an expand button on hover. Clicking it opens it fullscreen, read-only.
 */
function NoteImage({ node: _node, className, style, src, alt, title, ...props }: ComponentProps<"img"> & { node?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  // Counted up as the lightbox closes, so the markup's loaded again.
  const [opened, setOpened] = useState(0);
  if (!src) return <img alt={alt} title={title} {...props} />;
  return (
    <span className={`note-figure group ${className ?? ""}`} style={style}>
      <img src={src} alt={alt ?? ""} title={title} {...props} onClick={() => setExpanded(true)} className="cursor-zoom-in" />
      <MarkupOverlay src={src} version={opened} />
      <ExpandButton onClick={() => setExpanded(true)} />
      {title && <span className="mt-1.5 block text-center text-[14px] italic text-text-secondary">{title}</span>}
      {expanded && (
        <MediaLightbox
          src={src}
          alt={alt}
          title={title}
          onClose={() => {
            setExpanded(false);
            setOpened((n) => n + 1);
          }}
        />
      )}
    </span>
  );
}

/**
 * react-markdown's URL filter, letting links to local files and folders through (a drive letter reads as an unknown
 * protocol). The parser percent-encodes a link's destination, so a drive or UNC path is decoded back to the path itself
 * (`O:%5CMy%20Files` to `O:\My Files`) for openLocalFile; a `file:` URL stays a URL. A UNC path saved as is (a pill's,
 * see referencePill) has its leading `\\` read as an escaped backslash, so it comes as `\server\share\…`: its second
 * backslash is put back.
 */
function noteUrlTransform(url: string): string {
  if (/^file:/i.test(url)) return url;
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // A stray `%`: leave it be.
  }
  if (/^\\(?=[^\\/\s]+[\\/])/.test(decoded)) decoded = `\\${decoded}`;
  return isLocalHref(decoded) ? decoded : defaultUrlTransform(url);
}

/**
 * A code block as the read-only note shows it: a ```whiteboard block (see noteFormatting) as its board, read-only, a
 * ```listen block as its widget (which can record and tag speakers here too: the backend saves those into the note,
 * see ListenWidget), unless `interactive` is false; any other code block as code.
 */
function notePre(interactive: boolean): Components["pre"] {
  return ({ node, ...props }) => {
    const code = node?.children[0];
    const classes = code?.type === "element" && code.tagName === "code" ? code.properties.className : null;
    const fence = (lang: string) => code?.type === "element" && Array.isArray(classes) && classes.includes(`language-${lang}`);
    const text = () =>
      code?.type === "element" ? code.children.map((child) => (child.type === "text" ? child.value : "")).join("").trim() : "";
    if (fence("whiteboard")) return <WhiteboardFrame value={text()} editable={false} />;
    if (fence("listen")) return <ListenWidget value={text()} interactive={interactive} />;
    return <pre {...props} />;
  };
}

const NOTE_COMPONENTS: Components = {
  img: NoteImage,
  pre: notePre(true),
  // Inline code holding a local path, as the chat cites files (`\\server\share\…`, `Y:\…`), opens the file too.
  code: ({ node: _node, ref: _ref, ...props }) => {
    const text = typeof props.children === "string" ? props.children.trim() : "";
    if (/language-/.test(props.className ?? "") || text.includes("\n") || !isLocalHref(text)) return <code {...props} />;
    return (
      <code
        {...props}
        role="link"
        tabIndex={0}
        title={`Open ${text}`}
        className="cursor-pointer hover:border-accent hover:text-accent"
        onClick={() => void openLocalFile(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void openLocalFile(text);
        }}
      />
    );
  },
  a: ({ node: _node, ref, ...props }) => {
    // A task or note pill opens in the app, a URL pill in a new tab (see referencePill), and a link to a local file or
    // folder, pill or plain, through the backend: the browser won't open a local path from a web page.
    const [params] = useSearchParams();
    const { spaceId: activeSpaceId } = useSpace();
    const spaceId = Number(params.get("space") ?? activeSpaceId);
    const kind = refKind(props.title, props.href);
    if (isLocalHref(props.href) && (!kind || kind === "url")) return <LocalFileLink href={props.href}>{props.children}</LocalFileLink>;
    if (kind === "task" && props.href) return <TaskPillLink href={props.href}>{props.children}</TaskPillLink>;
    if (kind === "note" && props.href) {
      let noteRelPath = props.href;
      try {
        noteRelPath = decodeURIComponent(props.href);
      } catch {
        // ignore
      }
      const target = props.href.startsWith("/note?") ? props.href : notePath(spaceId, noteRelPath);
      return (
        <Link to={target} className="reference-pill note">
          <PillIcon kind="note" />
          <span className="reference-pill-label">{props.children}</span>
        </Link>
      );
    }
    if (kind && kind !== "url" && props.href)
      return (
        <Link to={props.href} className={`reference-pill ${kind}`}>
          <PillIcon kind={kind} />
          <span className="reference-pill-label">{props.children}</span>
        </Link>
      );
    if (kind)
      return (
        <a href={props.href} title={props.href} target="_blank" rel="noopener noreferrer" className="reference-pill url">
          <PillIcon kind="url" />
          <span className="reference-pill-label">{props.children}</span>
        </a>
      );
    if (props.href?.includes("/api/notes/image/") && isPdfUrl(props.href)) return <PdfLink href={props.href}>{props.children}</PdfLink>;
    return <a {...props} target={props.href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" />;
  },
};

const PREVIEW_COMPONENTS: Components = { ...NOTE_COMPONENTS, pre: notePre(false) };

/** A link to a local file or folder in the read-only note, shown as a pill: opens it on click (see openLocalFile). */
function LocalFileLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      className="reference-pill url"
      onClick={(e) => {
        e.preventDefault();
        void openLocalFile(href);
      }}
    >
      <PillIcon kind="url" href={href} />
      <span className="reference-pill-label">{children}</span>
    </a>
  );
}

/** A PDF attached to the read-only note: its pill opens it in the lightbox, read-only. */
function PdfLink({ href, children }: { href: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <>
      <a
        ref={ref}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          // Ctrl/Cmd-click still opens it in a new tab.
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && <MediaLightbox src={href} title={ref.current?.textContent || null} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A task pill in the read-only note: opens the task in the side panel, staying on the note. */
function TaskPillLink({ href, children }: { href: string; children: ReactNode }) {
  const { openTask } = useTaskPanel();
  const taskId = taskIdFromHref(href);
  const taskInfo = useTaskInfo(taskId);
  const status = taskInfo?.status ?? null;
  const assignee = taskInfo?.assignee ?? null;
  return (
    <Link
      to={href}
      className="reference-pill task"
      onClick={(e) => {
        // Ctrl/Cmd-click still opens the backlog in a new tab.
        if (taskId === null || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        openTask(taskId);
      }}
    >
      <PillIcon kind="task" />
      <span className="reference-pill-label">
        {status && <StatusTag status={status} />}
        {children}
        {assignee && <AssigneeTag assignee={assignee} />}
      </span>
    </Link>
  );
}

function LinkedTasks({ tasks }: { tasks: TaskItem[] }) {
  const { taskId, openTask } = useTaskPanel();
  return (
    <section aria-label="Linked tasks" className="rounded-lg border border-border-default bg-surface-raised">
      <h2 className="flex items-center justify-between border-b border-border-default px-4 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
        <span>Linked tasks</span>
        <Link to="/tasks/backlog" className="print:hidden normal-case tracking-normal text-accent hover:underline">
          Backlog
        </Link>
      </h2>
      <ul className="divide-y divide-border-default/60">
        {tasks.map((task) => (
          <li key={task.id} className={`flex items-center gap-2 px-4 py-2 text-[15px] ${taskId === task.id ? "bg-surface-active" : ""}`}>
            <button
              type="button"
              onClick={() => openTask(task.id)}
              title="Open task details"
              className={`flex-1 truncate text-left hover:underline ${task.status === "done" ? "text-text-muted line-through" : "text-text-primary"}`}
            >
              {task.title}
            </button>
            {task.project_code && (
              <ProjectTag code={task.project_code} color={task.project_color} />
            )}
            <Tag className={NEUTRAL_TAG}>{STATUS_LABELS[task.status]}</Tag>
            {task.assignee && <span className="text-xs text-text-muted">👤 {task.assignee}</span>}
            {task.deadline && (
              <span className={`font-mono text-xs ${isOverdue(task) ? "text-accent" : "text-text-muted"}`}>
                {formatDay(task.deadline)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
