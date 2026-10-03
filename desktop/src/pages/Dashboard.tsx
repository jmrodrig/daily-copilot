import { useEffect, useState } from "react";

import GanttChart, { type GanttProject } from "../components/GanttChart";

type Health = { state: "loading" } | { state: "ok"; status: string } | { state: "error"; message: string };

const DOT_COLOR: Record<Health["state"], string> = {
  loading: "bg-project-neutral",
  ok: "bg-project-p5002",
  error: "bg-red-400",
};

type Gantt = { state: "loading" } | { state: "ok"; projects: GanttProject[] } | { state: "error"; message: string };

export default function Dashboard() {
  const [health, setHealth] = useState<Health>({ state: "loading" });
  const [gantt, setGantt] = useState<Gantt>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/health", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: { status: string } = await res.json();
        setHealth({ state: "ok", status: body.status });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/gantt", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: { projects: GanttProject[] } = await res.json();
        setGantt({ state: "ok", projects: body.projects });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setGantt({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <section className="max-w-3xl rounded-lg border border-border-default bg-surface-raised p-5">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Backend</h2>
        <div className="flex items-center gap-3 font-mono text-sm">
          <span className={`h-2.5 w-2.5 rounded-full ${DOT_COLOR[health.state]}`} />
          {health.state === "loading" && <span className="text-text-secondary">Checking /health…</span>}
          {health.state === "ok" && <span>/health → {health.status}</span>}
          {health.state === "error" && (
            <span className="text-text-secondary">
              Unreachable ({health.message}) — is uvicorn running on port 8000?
            </span>
          )}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Plan</h2>
        {gantt.state === "loading" && <p className="text-sm text-text-secondary">Loading /api/gantt�</p>}
        {gantt.state === "error" && (
          <p className="text-sm text-text-secondary">Could not load the Gantt ({gantt.message}).</p>
        )}
        {gantt.state === "ok" && <GanttChart projects={gantt.projects} />}
      </section>
    </div>
  );
}
