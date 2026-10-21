import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Segment, ToolIcon } from "./markupUi";
import { SpreadsheetBlock } from "./noteFormatting";
import { type CellPos } from "./spreadsheet";
import SpreadsheetView from "./SpreadsheetView";
import { COLLAPSE_ICON, EXPAND_ICON } from "./WhiteboardWidget";

const TRASH_ICON = "M2.5 4.5h11 M6 4.5V3h4v1.5 M4 4.5l.7 9h6.6l.7-9 M6.8 7v4.5 M9.2 7v4.5";

/** A spreadsheet's icon: a grid with a header row, in a 16 × 16 box. */
export function SpreadsheetIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.7" y="2.2" width="12.6" height="11.6" rx="1.2" />
      <path d="M1.7 5.8h12.6 M1.7 9.6h12.6 M6 2.2v11.6 M10.2 5.8v8" />
    </svg>
  );
}

/**
 * A spreadsheet embedded in a note: a compact preview of its grid in the text column, just the size of its cells (its
 * display area), with buttons to open it in full view (and back, with Escape or the same button) to be edited, with
 * its toolbar and formula bar, showing on hover. While it's in full view, its place in the note says so, so only one
 * copy is ever edited.
 */
export function SpreadsheetFrame({
  value,
  onChange,
  editable,
  onSave,
  onRemove,
  selected = false,
}: {
  value: string;
  onChange?: (json: string) => void;
  editable: boolean;
  onSave?: () => void;
  onRemove?: () => void;
  selected?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [startCell, setStartCell] = useState<CellPos | undefined>(undefined);

  const open = (cell?: CellPos) => {
    setStartCell(cell);
    setFullscreen(true);
  };

  const controls = (full: boolean) => (
    <>
      <Segment
        on={false}
        label={full ? "Back to the note (Esc)" : editable ? "Open in full view to edit" : "Open in full view"}
        onClick={() => (full ? setFullscreen(false) : open())}
      >
        <ToolIcon path={full ? COLLAPSE_ICON : EXPAND_ICON} />
      </Segment>
      {editable && onRemove && !full && (
        <Segment on={false} label="Remove the spreadsheet from the note" onClick={onRemove}>
          <ToolIcon path={TRASH_ICON} />
        </Segment>
      )}
    </>
  );

  return (
    <div
      data-spreadsheet-frame
      className={`spreadsheet-frame group relative my-4 w-fit max-w-full overflow-hidden rounded-lg border print:hidden ${
        selected ? "border-accent" : "border-border-default"
      }`}
    >
      {fullscreen ? (
        <div className="flex flex-col items-center justify-center gap-3 bg-surface-raised px-8 py-6 text-[15px] text-text-muted">
          The spreadsheet is open in full view.
          <button type="button" className="btn" onClick={() => setFullscreen(false)}>
            Back to the note
          </button>
        </div>
      ) : (
        <>
          <SpreadsheetView value={value} editable={editable} compact onExpand={open} className="max-w-full" />
          <div
            className={`absolute right-1 top-1 z-40 flex items-center rounded-md border border-border-default bg-surface-raised shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
              selected ? "opacity-100" : "opacity-0"
            }`}
          >
            {controls(false)}
          </div>
        </>
      )}
      {fullscreen &&
        createPortal(
          <div role="dialog" aria-modal aria-label="Spreadsheet" className="fixed inset-0 z-50 flex flex-col bg-background">
            <SpreadsheetView
              value={value}
              onChange={onChange}
              editable={editable}
              initialCell={startCell}
              autoFocus
              onEscape={() => setFullscreen(false)}
              onSave={onSave}
              toolbarEnd={controls(true)}
              className="h-full w-full"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

type SpreadsheetOptions = {
  /** Ctrl/Cmd+S in the spreadsheet: the editor never hears it. */
  onSave?: () => void;
};

/**
 * The embedded spreadsheet node (see noteFormatting) shown as its grid. The grid owns its events (keys, clicks,
 * copy and paste), so the editor neither selects nor types on them; each finished edit is written back into the
 * node's `data`, so it's saved with the note's markdown.
 */
export const SpreadsheetNode = SpreadsheetBlock.extend<SpreadsheetOptions>({
  addOptions() {
    return { onSave: undefined };
  },
  addNodeView() {
    return ReactNodeViewRenderer(SpreadsheetNodeView, { stopEvent: () => true });
  },
});

function SpreadsheetNodeView({ node, editor, extension, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const options = extension.options as SpreadsheetOptions;
  const editable = useEditorState({ editor, selector: ({ editor: e }) => e.isEditable });
  const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
  return (
    <NodeViewWrapper className="spreadsheet-node">
      <SpreadsheetFrame
        value={data}
        onChange={(json) => {
          if (json !== data) updateAttributes({ data: json });
        }}
        editable={editable}
        onSave={options.onSave}
        onRemove={deleteNode}
        selected={selected}
      />
    </NodeViewWrapper>
  );
}
