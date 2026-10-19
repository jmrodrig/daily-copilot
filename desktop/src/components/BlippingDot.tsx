/** The white dot that blips while a recording runs (held still, and dimmed, while it's paused). */
export default function BlippingDot({ paused = false }: { paused?: boolean }) {
  return (
    <span aria-hidden className="relative flex h-3 w-3 items-center justify-center">
      {!paused && <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-white opacity-60" />}
      <span className={`relative inline-flex h-2 w-2 rounded-full shadow-sm ${paused ? "bg-text-muted" : "bg-white"}`} />
    </span>
  );
}
