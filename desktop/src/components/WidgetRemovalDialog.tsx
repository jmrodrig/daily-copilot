import { createPortal } from "react-dom";

import { useVoiceRecording } from "../context/VoiceRecordingContext";
import type { WidgetRemoval } from "../extensions/WidgetRemovalGuard";

function wording(removal: WidgetRemoval): { title: string; text: string; remove: string } {
  if (removal.type === "whiteboard") {
    return {
      title: "Remove whiteboard widget?",
      text: "This whiteboard and any drawings in it will be deleted from the note. Do you want to proceed?",
      remove: "Remove",
    };
  }
  switch (removal.reason) {
    case "listening":
      return {
        title: "Voice recording is currently active",
        text: "The widget is still listening. Removing or replacing it will interrupt the recording and all recording will be lost. Do you want to proceed?",
        remove: "Interrupt & Remove",
      };
    case "recorded":
      return {
        title: "Remove recording widget?",
        text: "This note contains recorded meeting audio and transcript. Removing or replacing it will delete the recording from the note. Do you want to proceed?",
        remove: "Remove",
      };
    default:
      return {
        title: "Remove listen widget?",
        text: "Removing or replacing this widget will delete it from the note. Do you want to proceed?",
        remove: "Remove",
      };
  }
}

/**
 * Asks before an edit removes a listen widget or a whiteboard (see WidgetRemovalGuard). Keep Widget has the focus, so
 * Enter keeps it, as do Escape and a click outside. `onRemove` makes the edit (false if it couldn't be made), and a
 * recording the widget was making is then thrown away.
 */
export default function WidgetRemovalDialog({
  removal,
  onKeep,
  onRemove,
}: {
  removal: WidgetRemoval;
  onKeep: () => void;
  onRemove: () => boolean;
}) {
  const voice = useVoiceRecording();
  const listening = removal.type === "listen" && removal.reason === "listening";
  const { title, text, remove: removeLabel } = wording(removal);
  const remove = () => {
    if (!onRemove() || !listening || !voice.status.is_recording) return;
    void voice.cancel();
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={onKeep}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="widget-removal-title"
        aria-describedby="widget-removal-text"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onKeep();
          }
        }}
        className="panel flex w-[480px] animate-dialog-in flex-col gap-3"
      >
        <h2 id="widget-removal-title" className="flex items-center gap-2 text-base font-semibold">
          {listening && <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />}
          {title}
        </h2>
        <p id="widget-removal-text" className="text-[15px] text-text-secondary">
          {text}
        </p>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn border-red-500/60 text-red-500 hover:bg-red-500/10" onClick={remove}>
            {removeLabel}
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
