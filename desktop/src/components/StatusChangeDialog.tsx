import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";

import { sendJson } from "../lib/api";
import { commentRequested, STATUS_LABELS, statusChangeComment, type StatusFlow, type TaskStatus } from "../lib/tasks";
import { ME } from "./TriageBoard";

/** What the user chose in the dialog: `null` when they cancelled, else the optional comment. */
export type StatusChangeAnswer = { comment: string | null } | null;

type Pending = { title: string; from: TaskStatus; to: TaskStatus; resolve: (answer: StatusChangeAnswer) => void };

/**
 * Asks for a comment when a task's status changes and the space's status flow marks that move as asking for one
 * (Jira-style); other moves answer straight away without a comment. Render `dialog` somewhere in the component and
 * `await ask(...)` before saving the change.
 */
export function useStatusChangePrompt(): {
  ask: (task: { title: string; status: TaskStatus }, to: TaskStatus, flow: StatusFlow | null | undefined) => Promise<StatusChangeAnswer>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const ask = useCallback(
    (task: { title: string; status: TaskStatus }, to: TaskStatus, flow: StatusFlow | null | undefined) =>
      new Promise<StatusChangeAnswer>((resolve) => {
        if (!commentRequested(flow, task.status, to)) return resolve({ comment: null });
        pendingRef.current?.resolve(null); // a second change replaces an unanswered one
        const next = { title: task.title, from: task.status, to, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const answer = useCallback((value: StatusChangeAnswer) => {
    pendingRef.current?.resolve(value);
    pendingRef.current = null;
    setPending(null);
  }, []);

  return { ask, dialog: pending && <StatusChangeDialog key={`${pending.title}:${pending.to}`} pending={pending} onAnswer={answer} /> };
}

/** Adds the comment left in the dialog to the task's discussion, prefixed with the change it explains. */
export function postStatusComment(taskId: number, from: TaskStatus, to: TaskStatus, comment: string) {
  return sendJson("POST", `/api/tasks/${taskId}/comments`, { text: statusChangeComment(from, to, comment), author: ME });
}

function StatusChangeDialog({ pending, onAnswer }: { pending: Pending; onAnswer: (answer: StatusChangeAnswer) => void }) {
  const [comment, setComment] = useState("");

  function submit(event?: FormEvent) {
    event?.preventDefault();
    onAnswer({ comment: comment.trim() || null });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={() => onAnswer(null)}>
      <form
        role="dialog"
        aria-modal
        aria-label="Change status"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onAnswer(null);
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
        }}
        className="panel flex w-[460px] flex-col gap-3"
      >
        <h2 className="text-base font-semibold">Change status</h2>
        <p className="text-[15px] text-text-secondary">
          <span className="text-text-primary">{pending.title}</span>
          <span className="mt-1 block font-mono text-[13px] text-text-muted">
            {STATUS_LABELS[pending.from]} → <span className="text-accent">{STATUS_LABELS[pending.to]}</span>
          </span>
        </p>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Comment (optional)
          <textarea
            autoFocus
            aria-label="Status change comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Why is the status changing? (Ctrl+Enter to save)"
            className="field resize-y py-2 text-[15px] leading-5"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn min-h-9 px-3 text-xs" onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="button" className="btn min-h-9 px-3 text-xs" onClick={() => onAnswer({ comment: null })}>
            Skip comment
          </button>
          <button type="submit" className="btn-primary min-h-9 px-3 text-xs">
            {comment.trim() ? "Change & comment" : "Change status"}
          </button>
        </div>
      </form>
    </div>
  );
}
