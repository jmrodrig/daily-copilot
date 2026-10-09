import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Segment, ToolIcon } from "./markupUi";
import { WhiteboardBlock } from "./noteFormatting";
import WhiteboardView from "./WhiteboardView";

/** The square-cornered arrows of a fullscreen button, out or in, in a 16 × 16 box. */
const EXPAND_ICON = "M9.5 2.5h4v4 M13.5 2.5L9 7 M6.5 13.5h-4v-4 M2.5 13.5L7 9";
const COLLAPSE_ICON = "M13.5 6.5h-4v-4 M9.5 6.5L14 2 M2.5 9.5h4v4 M6.5 9.5L2 14";
const TRASH_ICON = "M2.5 4.5h11 M6 4.5V3h4v1.5 M4 4.5l.7 9h6.6l.7-9 M6.8 7v4.5 M9.2 7v4.5";

/**
 * A whiteboard embedded in a note: the board, at a fixed height in the text column, which can go fullscreen (and
 * back, with Escape or the same button). While it's fullscreen, its place in the note says so, so only one copy is
 * ever edited. In the column the wheel scrolls the note (Ctrl/Cmd+wheel zooms); fullscreen, it pans the board.
 */
export function WhiteboardFrame({
  value,
  onChange,
  editable,
  spaceId,
  onSave,
  onRemove,
  selected = false,
}: {
  value: string;
  onChange?: (json: string) => void;
  editable: boolean;
  spaceId?: number;
  onSave?: () => void;
  onRemove?: () => void;
  selected?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);

  const controls = (full: boolean) => (
    <>
      <Segment on={false} label={full ? "Exit fullscreen (Esc)" : "Fullscreen"} onClick={() => setFullscreen(!full)}>
        <ToolIcon path={full ? COLLAPSE_ICON : EXPAND_ICON} />
      </Segment>
      {editable && onRemove && !full && (
        <Segment on={false} label="Remove the whiteboard from the note" onClick={onRemove}>
          <ToolIcon path={TRASH_ICON} />
        </Segment>
      )}
    </>
  );

  const board = (full: boolean) => (
    <WhiteboardView
      value={value}
      onChange={onChange}
      editable={editable}
      spaceId={spaceId}
      onSave={onSave}
      captureWheel={full}
      autoFocus={full}
      onEscape={full ? () => setFullscreen(false) : undefined}
      toolbarEnd={controls(full)}
      className="h-full w-full"
    />
  );

  return (
    <div
      data-whiteboard-frame
      className={`whiteboard-frame relative my-4 h-[520px] overflow-hidden rounded-lg border print:hidden ${
        selected ? "border-accent" : "border-border-default"
      }`}
    >
      {fullscreen ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised text-[15px] text-text-muted">
          The whiteboard is open fullscreen.
          <button type="button" className="btn" onClick={() => setFullscreen(false)}>
            Back to the note
          </button>
        </div>
      ) : (
        board(false)
      )}
      {fullscreen &&
        createPortal(
          <div role="dialog" aria-modal aria-label="Whiteboard" className="fixed inset-0 z-50 flex flex-col bg-background">
            {board(true)}
          </div>,
          document.body,
        )}
    </div>
  );
}

type WhiteboardOptions = {
  /** The space files inserted on the board are uploaded to. */
  spaceId?: number;
  /** Ctrl/Cmd+S on the board: the editor never hears it. */
  onSave?: () => void;
};

/**
 * The embedded whiteboard node (see noteFormatting) shown as a live board. The board owns its events (pointers, keys,
 * drops and pastes), so the editor neither selects nor types on them; each finished edit is written back into the
 * node's `data`, so it's saved with the note's markdown.
 */
export const WhiteboardNode = WhiteboardBlock.extend<WhiteboardOptions>({
  addOptions() {
    return { spaceId: undefined, onSave: undefined };
  },
  addNodeView() {
    return ReactNodeViewRenderer(WhiteboardNodeView, { stopEvent: () => true });
  },
});

function WhiteboardNodeView({ node, editor, extension, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const options = extension.options as WhiteboardOptions;
  const editable = useEditorState({ editor, selector: ({ editor: e }) => e.isEditable });
  const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
  return (
    <NodeViewWrapper className="whiteboard-node">
      <WhiteboardFrame
        value={data}
        onChange={(json) => {
          if (json !== data) updateAttributes({ data: json });
        }}
        editable={editable}
        spaceId={options.spaceId}
        onSave={options.onSave}
        onRemove={deleteNode}
        selected={selected}
      />
    </NodeViewWrapper>
  );
}
