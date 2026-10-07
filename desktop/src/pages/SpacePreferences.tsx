import { useEffect, useState, type FormEvent } from "react";

import { message } from "../lib/api";
import { useSpace } from "../lib/space";
import { useTitle } from "../lib/title";

export default function SpacePreferences() {
  const { space, updateSpace } = useSpace();
  const [name, setName] = useState(space?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useTitle("Space preferences");

  // Reset the form when the active space changes (or the spaces finish loading).
  useEffect(() => {
    setName(space?.name ?? "");
    setError(null);
    setSaved(false);
  }, [space?.id, space?.name]);

  const trimmed = name.trim();
  const valid = space !== undefined && trimmed !== "" && trimmed !== space.name;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!space || !valid || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSpace(space.id, trimmed);
      setSaved(true);
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5 px-9 py-7">
      <header>
        <div className="font-mono text-xs tracking-[0.06em] text-text-muted">SPACE PREFERENCES</div>
        <h1 className="mt-1 text-[29px] font-semibold">{space?.name ?? "Space"}</h1>
        <div className="mt-1 text-[15px] text-text-muted">Configure the current space.</div>
      </header>

      <section className="panel flex flex-col gap-3" aria-label="General">
        <h2 className="text-base font-semibold">General</h2>
        {space === undefined ? (
          <p className="text-[15px] text-text-muted">Loading…</p>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold tracking-[0.08em] text-text-muted">NAME</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                className="field"
                maxLength={64}
                required
              />
            </label>
            {error && <p className="text-xs text-accent">Could not save ({error}).</p>}
            {saved && <p className="text-xs text-text-secondary">Saved.</p>}
            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={!valid || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel flex flex-col gap-1.5" aria-label="Environment configuration">
        <h2 className="text-base font-semibold">Environment Configuration</h2>
        <p className="text-[15px] text-text-muted">
          Coming soon: configure this space's task types, statuses and more.
        </p>
      </section>
    </div>
  );
}
