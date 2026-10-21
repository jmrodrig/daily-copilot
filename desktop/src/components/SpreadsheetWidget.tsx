import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { message, uploadFile } from "../lib/api";
import { Segment, ToolIcon } from "./markupUi";
import { SpreadsheetBlock } from "./noteFormatting";
import { SPREADSHEET_FILE_ACCEPT, isSpreadsheetFile, parseRangeAddress, parseSpreadsheet, serializeSpreadsheet, type CellPos } from "./spreadsheet";
import SpreadsheetView from "./SpreadsheetView";
import { COLLAPSE_ICON, EXPAND_ICON } from "./WhiteboardWidget";
import { createWorkbook, flushWorkbook, isAttachmentHref, openInNativeApp, updateWorkbook, useWorkbook, workbookTitle } from "./workbookStore";

const TRASH_ICON = "M2.5 4.5h11 M6 4.5V3h4v1.5 M4 4.5l.7 9h6.6l.7-9 M6.8 7v4.5 M9.2 7v4.5";
/** A dashed box with a corner, for choosing the cells a window shows. */
const AREA_ICON = "M2.5 5.5v-3h3 M10.5 2.5h3v3 M13.5 10.5v3h-3 M5.5 13.5h-3v-3 M5.5 5.5h5v5h-5z";
/** A box with an arrow out of it, for opening in another program. */
const OPEN_ICON = "M9.5 2.5h4v4 M13.5 2.5 8 8 M12 9.5v3.5a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5V4.5a.5.5 0 0 1 .5-.5H6.5";

/** A spreadsheet's icon: a grid with a header row, in a 16 × 16 box. */
export function SpreadsheetIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.7" y="2.2" width="12.6" height="11.6" rx="1.2" />
      <path d="M1.7 5.8h12.6 M1.7 9.6h12.6 M6 2.2v11.6 M10.2 5.8v8" />
    </svg>
  );
}

/** The frame a spreadsheet sits in, in the note: just the size of its grid, with its buttons showing on hover. */
function Frame({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <div
      data-spreadsheet-frame
      className={`spreadsheet-frame group relative my-4 w-fit max-w-full overflow-hidden rounded-lg border print:hidden ${
        selected ? "border-accent" : "border-border-default"
      }`}
    >
      {children}
    </div>
  );
}

function HoverControls({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <div
      className={`absolute right-1 top-1 z-40 flex items-center rounded-md border border-border-default bg-surface-raised shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
        selected ? "opacity-100" : "opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

/** In the note, where a spreadsheet open in full view sits meanwhile, so only one copy is ever edited. */
function OpenElsewhere({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 bg-surface-raised px-8 py-6 text-[15px] text-text-muted">
      The spreadsheet is open in full view.
      <button type="button" className="btn" onClick={onBack}>
        Back to the note
      </button>
    </div>
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
    <Frame selected={selected}>
      {fullscreen ? (
        <OpenElsewhere onBack={() => setFullscreen(false)} />
      ) : (
        <>
          <SpreadsheetView value={value} editable={editable} compact onExpand={open} className="max-w-full" />
          <HoverControls selected={selected}>{controls(false)}</HoverControls>
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
    </Frame>
  );
}

/** What a window onto a workbook file shows: cells `displayArea` of sheet `sheet` of the file at `src`. */
export type SpreadsheetWindowData = { src: string; sheet?: string; displayArea?: string; title?: string };

/**
 * A ```spreadsheet block's JSON, read: a window onto a workbook file (with `src`), a spreadsheet embedded in the note
 * itself (with `sheets`, as notes saved them before files), or a window yet to be pointed at a file.
 */
export function parseSpreadsheetBlock(json: string): { kind: "window"; data: SpreadsheetWindowData } | { kind: "embedded" } | { kind: "empty" } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "embedded" };
  }
  if (!raw || typeof raw !== "object") return { kind: "embedded" };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.src === "string" && obj.src) {
    const text = (key: string) => (typeof obj[key] === "string" && (obj[key] as string).trim() ? (obj[key] as string) : undefined);
    const area = text("displayArea");
    return {
      kind: "window",
      data: {
        src: obj.src,
        ...(text("sheet") ? { sheet: text("sheet") } : {}),
        ...(area && parseRangeAddress(area) ? { displayArea: area } : {}),
        ...(text("title") ? { title: text("title") } : {}),
      },
    };
  }
  return Array.isArray(obj.sheets) ? { kind: "embedded" } : { kind: "empty" };
}

/**
 * A workbook file attached to a note, in full view over the app: every sheet, with its tabs, the toolbar (and "Open in
 * Excel"), the formula bar and the grid, each edit saved back to the file (see workbookStore). From a window in the
 * note, it's also where the window's cells are chosen: "Set display area" (`onSetDisplayArea`), the main action when
 * `selectingArea`.
 */
export function SpreadsheetModal({
  src,
  title,
  editable,
  onClose,
  sheet,
  displayArea,
  onSetDisplayArea,
  selectingArea = false,
}: {
  src: string;
  title?: string | null;
  editable: boolean;
  onClose: () => void;
  sheet?: string;
  displayArea?: { sheet: string; area?: string };
  onSetDisplayArea?: (sheet: string, area: string | undefined) => void;
  selectingArea?: boolean;
}) {
  const workbook = useWorkbook(src);
  const value = useMemo(() => (workbook.data ? serializeSpreadsheet(workbook.data) : ""), [workbook.data]);
  const name = workbookTitle(src, title);
  const canEdit = editable && !workbook.truncated;
  const area = displayArea?.area ? parseRangeAddress(displayArea.area) : null;

  const close = () => {
    void flushWorkbook(src);
    onClose();
  };

  const status = workbook.saving
    ? "Saving…"
    : workbook.saveError
      ? `Not saved: ${workbook.saveError}`
      : workbook.truncated
        ? "Too big to edit here: open it in Excel"
        : null;
  const end = (
    <>
      {status && <span className={`px-2 text-[13px] ${workbook.saveError || workbook.truncated ? "text-accent" : "text-text-muted"}`}>{status}</span>}
      <Segment on={false} label="Back to the note (Esc)" onClick={close}>
        <ToolIcon path={COLLAPSE_ICON} />
      </Segment>
    </>
  );

  return createPortal(
    <div role="dialog" aria-modal aria-label={name} className="fixed inset-0 z-50 flex flex-col bg-background">
      {workbook.data ? (
        <SpreadsheetView
          value={value}
          onChange={canEdit ? (json) => updateWorkbook(src, parseSpreadsheet(json)) : undefined}
          editable={canEdit}
          fileName={name}
          sheet={sheet ?? displayArea?.sheet}
          displayArea={displayArea}
          onSetDisplayArea={
            onSetDisplayArea &&
            ((sheetName, chosen) => {
              onSetDisplayArea(sheetName, chosen);
              if (selectingArea && chosen) close();
            })
          }
          selectingArea={selectingArea}
          onOpenNative={() => void openInNativeApp(src)}
          initialCell={area ? { row: area.r1, col: area.c1 } : undefined}
          autoFocus
          onEscape={close}
          onSave={() => void flushWorkbook(src)}
          toolbarEnd={end}
          className="h-full w-full"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-[15px] text-text-muted" onKeyDown={(e) => e.key === "Escape" && close()}>
          {workbook.error ? `Could not open ${name} (${workbook.error}).` : `Opening ${name}…`}
          <button type="button" className="btn" autoFocus onClick={close}>
            Back to the note
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * A window onto a workbook file in the note: the cells of its display area, typed in right there with the note's
 * text, each edit saved to the file and shown at once wherever else it's open (see workbookStore). On hover: open it
 * in full view, choose the cells it shows, open it in Excel, remove it. Published (not `editable`), it's just the
 * cells, without column letters or row numbers.
 */
function SpreadsheetWindow({
  data,
  onChange,
  editable,
  onRemove,
  selected,
  selectAtOnce,
}: {
  data: SpreadsheetWindowData;
  onChange?: (data: SpreadsheetWindowData) => void;
  editable: boolean;
  onRemove?: () => void;
  selected: boolean;
  /** Open in full view to choose its cells as soon as it's shown (just pointed at its file). */
  selectAtOnce: boolean;
}) {
  const workbook = useWorkbook(data.src);
  const [modal, setModal] = useState<"full" | "area" | null>(selectAtOnce ? "area" : null);
  const value = useMemo(() => (workbook.data ? serializeSpreadsheet(workbook.data) : ""), [workbook.data]);
  const name = workbookTitle(data.src, data.title);
  const sheet = workbook.data?.sheets.some((s) => s.name === data.sheet) ? data.sheet : workbook.data?.activeSheet;
  const canEdit = editable && !workbook.truncated && !!onChange;

  const setArea = (sheetName: string, area: string | undefined) => {
    const { displayArea: _old, ...rest } = data;
    onChange?.({ ...rest, sheet: sheetName, ...(area ? { displayArea: area } : {}) });
  };

  return (
    <Frame selected={selected}>
      {modal ? (
        <OpenElsewhere onBack={() => setModal(null)} />
      ) : workbook.data ? (
        <SpreadsheetView
          value={value}
          onChange={canEdit ? (json) => updateWorkbook(data.src, parseSpreadsheet(json)) : undefined}
          editable={canEdit}
          compact
          inlineEdit
          sheet={sheet}
          displayArea={sheet ? { sheet, area: data.displayArea } : undefined}
          onExpand={() => setModal("full")}
          className="max-w-full"
        />
      ) : (
        <div className="flex items-center gap-2 bg-surface-raised px-4 py-3 text-[14px] text-text-muted">
          <SpreadsheetIcon />
          {workbook.error ? `Could not open ${name} (${workbook.error}).` : `Opening ${name}…`}
        </div>
      )}
      {!modal && (
        <HoverControls selected={selected}>
          <Segment on={false} label={`Open ${name} in full view`} onClick={() => setModal("full")}>
            <ToolIcon path={EXPAND_ICON} />
          </Segment>
          {editable && onChange && (
            <Segment on={false} label="Choose the cells the note shows" onClick={() => setModal("area")}>
              <ToolIcon path={AREA_ICON} />
            </Segment>
          )}
          <Segment on={false} label="Open in Excel (its program on this machine)" onClick={() => void openInNativeApp(data.src)}>
            <ToolIcon path={OPEN_ICON} />
          </Segment>
          {editable && onRemove && (
            <Segment on={false} label="Remove the window from the note (the file stays attached)" onClick={onRemove}>
              <ToolIcon path={TRASH_ICON} />
            </Segment>
          )}
        </HoverControls>
      )}
      {modal && (
        <SpreadsheetModal
          src={data.src}
          title={name}
          editable={editable}
          onClose={() => setModal(null)}
          sheet={sheet}
          displayArea={sheet ? { sheet, area: data.displayArea } : undefined}
          onSetDisplayArea={editable && onChange ? setArea : undefined}
          selectingArea={modal === "area"}
        />
      )}
    </Frame>
  );
}

/** A spreadsheet the note links to (or shows in a window): its link and file name. */
export type SpreadsheetAttachment = { href: string; label: string };

/**
 * A window not yet pointed at a workbook: pick one of the spreadsheets the note has (`attachments`), upload one, or
 * make a new one, then choose its cells in full view.
 */
function SpreadsheetPicker({
  attachments,
  spaceId,
  onPick,
  onRemove,
  selected,
}: {
  attachments: SpreadsheetAttachment[];
  spaceId?: number;
  onPick: (src: string, title: string) => void;
  onRemove?: () => void;
  selected: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, task: () => Promise<{ url: string; title: string }>) {
    setBusy(label);
    setError(null);
    try {
      const { url, title } = await task();
      onPick(url, title);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const button = "flex items-center gap-2 rounded-md border border-border-default px-3 py-1.5 text-[14px] text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <Frame selected={selected}>
      <div className="flex min-w-[22rem] flex-col gap-3 bg-surface-raised px-4 py-3">
        <div className="flex items-center gap-2 text-[15px] font-medium text-text-primary">
          <SpreadsheetIcon />
          Spreadsheet window
          <span className="font-normal text-text-muted">· choose a spreadsheet to show part of</span>
        </div>
        {attachments.length > 0 && (
          <ul className="flex flex-col gap-1">
            {attachments.map((a) => (
              <li key={a.href}>
                <button type="button" disabled={!!busy} onClick={() => onPick(a.href, a.label)} className={`${button} w-full text-left`}>
                  <SpreadsheetIcon size={14} />
                  <span className="truncate">{a.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!!busy || spaceId === undefined} onClick={() => fileRef.current?.click()} className={button}>
            {busy === "upload" ? "Uploading…" : "Upload spreadsheet"}
          </button>
          <button
            type="button"
            disabled={!!busy || spaceId === undefined}
            onClick={() => void run("new", () => createWorkbook(spaceId!))}
            className={button}
          >
            {busy === "new" ? "Creating…" : "Create new spreadsheet"}
          </button>
          {onRemove && (
            <button type="button" onClick={onRemove} className="ml-auto text-[13px] text-text-muted hover:text-text-primary">
              Remove
            </button>
          )}
        </div>
        {error && <p className="text-[13px] text-accent">{error}</p>}
        <input
          ref={fileRef}
          type="file"
          accept={SPREADSHEET_FILE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file || spaceId === undefined) return;
            if (!isSpreadsheetFile(file)) return setError(`${file.name} isn't a spreadsheet.`);
            void run("upload", async () => ({ url: (await uploadFile(spaceId, file)).url, title: file.name }));
          }}
        />
      </div>
    </Frame>
  );
}

/**
 * A ```spreadsheet block, as the note shows it (see parseSpreadsheetBlock): a window onto a workbook file, a spreadsheet
 * embedded in the note, or, while editing, the picker for a window's file. `onChange` gets the block's new JSON.
 */
export function SpreadsheetBlockView({
  value,
  onChange,
  editable,
  onSave,
  onRemove,
  selected = false,
  spaceId,
  attachments = [],
}: {
  value: string;
  onChange?: (json: string) => void;
  editable: boolean;
  onSave?: () => void;
  onRemove?: () => void;
  selected?: boolean;
  spaceId?: number;
  attachments?: SpreadsheetAttachment[];
}) {
  // Just pointed at its file: its cells are chosen next.
  const [justPicked, setJustPicked] = useState(false);
  const block = parseSpreadsheetBlock(value);
  if (block.kind === "embedded") return <SpreadsheetFrame value={value} onChange={onChange} editable={editable} onSave={onSave} onRemove={onRemove} selected={selected} />;
  if (block.kind === "empty") {
    if (!editable || !onChange) return null;
    return (
      <SpreadsheetPicker
        attachments={attachments}
        spaceId={spaceId}
        selected={selected}
        onRemove={onRemove}
        onPick={(src, title) => {
          setJustPicked(true);
          onChange(JSON.stringify({ src, title }));
        }}
      />
    );
  }
  return (
    <SpreadsheetWindow
      data={block.data}
      onChange={onChange && ((data) => onChange(JSON.stringify(data)))}
      editable={editable}
      onRemove={onRemove}
      selected={selected}
      selectAtOnce={justPicked}
    />
  );
}

type SpreadsheetOptions = {
  /** The space files are uploaded to and new workbooks made in. */
  spaceId?: number;
  /** Ctrl/Cmd+S in the spreadsheet: the editor never hears it. */
  onSave?: () => void;
};

/**
 * The spreadsheet node (see noteFormatting) shown as its block (see SpreadsheetBlockView). The grid owns its events
 * (keys, clicks, copy and paste), so the editor neither selects nor types on them; each change to the block is written
 * back into the node's `data`, so it's saved with the note's markdown.
 */
export const SpreadsheetNode = SpreadsheetBlock.extend<SpreadsheetOptions>({
  addOptions() {
    return { spaceId: undefined, onSave: undefined };
  },
  addNodeView() {
    return ReactNodeViewRenderer(SpreadsheetNodeView, { stopEvent: () => true });
  },
});

function SpreadsheetNodeView({ node, editor, extension, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const options = extension.options as SpreadsheetOptions;
  const editable = useEditorState({ editor, selector: ({ editor: e }) => e.isEditable });
  const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
  const empty = parseSpreadsheetBlock(data).kind === "empty";
  // The spreadsheets the note links to or shows, for a window to pick from.
  const attachments = useEditorState({
    editor,
    selector: ({ editor: e }) => (empty ? noteSpreadsheets(e.state.doc) : []),
  });
  return (
    <NodeViewWrapper className="spreadsheet-node">
      <SpreadsheetBlockView
        value={data}
        onChange={(json) => {
          if (json !== data) updateAttributes({ data: json });
        }}
        editable={editable}
        onSave={options.onSave}
        onRemove={deleteNode}
        selected={selected}
        spaceId={options.spaceId}
        attachments={attachments}
      />
    </NodeViewWrapper>
  );
}

/** The workbook files a note links to, or shows in its windows, each once. */
function noteSpreadsheets(doc: NodeViewProps["editor"]["state"]["doc"]): SpreadsheetAttachment[] {
  const found = new Map<string, string>();
  doc.descendants((child) => {
    if (child.isText) {
      const href = child.marks.find((mark) => mark.type.name === "link")?.attrs.href as string | undefined;
      if (isAttachmentHref(href) && isSpreadsheetFile(href) && !found.has(href)) found.set(href, workbookTitle(href, child.text));
    } else if (child.type.name === "spreadsheet") {
      const block = parseSpreadsheetBlock(String(child.attrs.data ?? ""));
      if (block.kind === "window" && !found.has(block.data.src)) found.set(block.data.src, workbookTitle(block.data.src, block.data.title));
    }
    return true;
  });
  return [...found].map(([href, label]) => ({ href, label }));
}
