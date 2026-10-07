import { useEffect, useState } from "react";

import { normalizeHex, optionColor, PALETTE, pillStyle, type HexColor } from "../lib/colors";
import type { CustomFieldDef } from "../lib/space";
import type { CustomFieldValue } from "../lib/tasks";
import { Tag } from "./TriageBoard";

/**
 * Picks a stored colour: the preset swatches, "none", and a hex box for any other colour (applied once it's a valid
 * "#rgb" / "#rrggbb" code). `label` names what is being coloured, for screen readers.
 */
export default function ColorPicker({
  value,
  onChange,
  label,
  allowNone = true,
}: {
  value: HexColor | null;
  onChange: (color: HexColor | null) => void;
  label: string;
  allowNone?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const swatch = "h-5 w-5 shrink-0 rounded-full border";

  return (
    <div role="group" aria-label={`Colour of ${label}`} className="flex flex-wrap items-center gap-1">
      {allowNone && (
        <button
          type="button"
          aria-label="No colour"
          aria-pressed={value === null}
          title="No colour"
          onClick={() => onChange(null)}
          className={`${swatch} relative overflow-hidden bg-surface-panel ${value === null ? "border-text-primary" : "border-border-strong"}`}
        >
          <span aria-hidden className="absolute left-1/2 top-[-2px] h-6 w-px rotate-45 bg-text-muted" />
        </button>
      )}
      {PALETTE.map(({ color, name }) => (
        <button
          key={color}
          type="button"
          aria-label={name}
          aria-pressed={value === color}
          title={`${name} (${color})`}
          onClick={() => onChange(color)}
          className={`${swatch} ${value === color ? "border-text-primary ring-2 ring-text-primary/40" : "border-transparent"}`}
          style={{ backgroundColor: color }}
        />
      ))}
      <input
        aria-label={`Hex colour of ${label}`}
        value={draft}
        placeholder="#hex"
        maxLength={7}
        onChange={(e) => {
          setDraft(e.target.value);
          const color = normalizeHex(e.target.value);
          if (color && color !== value) onChange(color);
        }}
        onBlur={() => setDraft(value ?? "")}
        className="field ml-1 w-[5.5rem] px-2 py-0.5 font-mono text-[13px]"
      />
    </div>
  );
}

/** A dropdown field's value as a pill in its option's colour (plain text when the option has none). */
export function OptionPill({ field, value }: { field: CustomFieldDef; value: CustomFieldValue | undefined }) {
  if (typeof value !== "string") return null;
  const color = optionColor(field, value);
  if (!color) return <span>{value}</span>;
  return (
    <Tag className="normal-case" style={pillStyle(color)} title={`${field.name}: ${value}`}>
      {value}
    </Tag>
  );
}
