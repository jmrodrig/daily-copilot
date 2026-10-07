import type { CSSProperties } from "react";

import type { CustomFieldDef } from "./space";
import type { CustomFieldValue } from "./tasks";

/** Colours as the backend stores them for projects and dropdown options: "#rrggbb", lower case. */
export type HexColor = string;

/** The preset swatches offered by the colour pickers (any other hex can still be typed). */
export const PALETTE: { color: HexColor; name: string }[] = [
  { color: "#6cb6ea", name: "Blue" },
  { color: "#b7a3f2", name: "Violet" },
  { color: "#56c8a8", name: "Green" },
  { color: "#e8b04b", name: "Amber" },
  { color: "#ef7f5a", name: "Orange" },
  { color: "#e5677d", name: "Red" },
  { color: "#e58ad0", name: "Pink" },
  { color: "#4fc1d6", name: "Cyan" },
  { color: "#a3b86b", name: "Olive" },
  { color: "#6b7a84", name: "Grey" },
];

/** `value` as a stored colour, or null if it isn't a "#rgb" / "#rrggbb" hex code. */
export function normalizeHex(value: string): HexColor | null {
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
}

/** `color` at `alpha` (0–1) as an 8-digit hex, for tinted backgrounds. */
export function tint(color: HexColor, alpha: number): string {
  return `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** Inline style of a pill (see Tag in TriageBoard) in a stored colour. */
export function pillStyle(color: HexColor): CSSProperties {
  return { borderColor: tint(color, 0.6), color, backgroundColor: tint(color, 0.12) };
}

/** The colour of a task's dropdown value, if the field gives that option one. */
export function optionColor(field: CustomFieldDef, value: CustomFieldValue | null | undefined): HexColor | null {
  if (field.type !== "dropdown" || typeof value !== "string") return null;
  return field.colors?.[value] ?? null;
}

/** A task's dropdown values that have a colour, in field order, for pills on cards and in the task panel. */
export function colouredOptions(
  fields: CustomFieldDef[],
  values: Record<string, CustomFieldValue>,
): { field: CustomFieldDef; option: string; color: HexColor }[] {
  return fields.flatMap((field) => {
    const option = values[field.id];
    const color = optionColor(field, option);
    return color && typeof option === "string" ? [{ field, option, color }] : [];
  });
}
