// Per-project colour classes. Full class names so Tailwind can find them; the colours come
// from shared/design-tokens.json. Unknown projects (and the Inbox) use the neutral swatch.
export type ProjectSwatch = {
  /** Small filled dot. */
  dot: string;
  /** Tinted block with a coloured border, e.g. a timeline entry. */
  block: string;
};

const SWATCHES: Record<string, ProjectSwatch> = {
  c7801: { dot: "bg-project-c7801", block: "border-project-c7801 bg-project-c7801/[0.18]" },
  r5301: { dot: "bg-project-r5301", block: "border-project-r5301 bg-project-r5301/[0.18]" },
  p5002: { dot: "bg-project-p5002", block: "border-project-p5002 bg-project-p5002/[0.18]" },
};
const NEUTRAL: ProjectSwatch = {
  dot: "bg-project-neutral",
  block: "border-project-neutral bg-project-neutral/[0.18]",
};

export function projectSwatch(code: string | null | undefined): ProjectSwatch {
  return (code && SWATCHES[code.toLowerCase()]) || NEUTRAL;
}
