import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import GanttChart, { type GanttDateChange, type GanttProject } from "../components/GanttChart";
import { getJson, message } from "../lib/api";
import { useSpace } from "../lib/space";
import { fromGanttDates, updateTaskDates, useTaskChanges, useTaskPanel } from "../lib/tasks";
import PageHeader from "../components/PageHeader";

type State = { state: "loading" } | { state: "ok"; project: GanttProject | null } | { state: "error"; message: string };

/** One project's shop floor Gantt (`/plan/:code`). */
export default function ProjectPlan() {
  const { code = "" } = useParams();
  const [gantt, setGantt] = useState<State>({ state: "loading" });
  const { spaceId, space } = useSpace();
  const { taskId, openTask } = useTaskPanel();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setGantt((prev) => (prev.state === "ok" ? prev : { state: "loading" }));
    getJson<{ projects: GanttProject[] }>(`/api/gantt?space_id=${spaceId}`, controller.signal)
      .then((body) =>
        setGantt({ state: "ok", project: body.projects.find((p) => p.code.toLowerCase() === code.toLowerCase()) ?? null }),
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setGantt({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [code, spaceId, reload]);

  // A task changed in the task panel: reload the plan for its new dates.
  useTaskChanges("board", () => setReload((n) => n + 1));

  /** Dragged or shifted on the chart: show the new dates at once; reload if saving fails (some may have saved). */
  const reschedule = useCallback(async (changes: GanttDateChange[]) => {
    const byId = new Map(changes.map((c) => [c.id, c]));
    setGantt((prev) =>
      prev.state === "ok" && prev.project
        ? {
            ...prev,
            project: {
              ...prev.project,
              tasks: prev.project.tasks.map((t) => {
                const change = byId.get(t.id);
                return change ? { ...t, ...change } : t;
              }),
            },
          }
        : prev,
    );
    setError(null);
    try {
      await updateTaskDates(changes.map(fromGanttDates));
    } catch (err: unknown) {
      setError(`Could not reschedule ${changes.length === 1 ? "the task" : `the ${changes.length} tasks`}: ${message(err)}`);
      setReload((n) => n + 1);
      throw err;
    }
  }, []);

  const project = gantt.state === "ok" ? gantt.project : null;
  return (
    <div className="flex flex-col gap-5 px-9 py-7">
      <PageHeader eyebrow={`${code.toUpperCase()} · PLAN`} title={project?.name || code} subtitle="Shop floor Gantt" />
      {gantt.state === "loading" && <p className="text-[15px] text-text-muted">Loading the Gantt…</p>}
      {gantt.state === "error" && (
        <p className="text-[15px] text-text-secondary">Could not load the Gantt ({gantt.message}).</p>
      )}
      {error && <p className="text-[15px] text-accent">{error}</p>}
      {gantt.state === "ok" &&
        (project && project.tasks.length > 0 ? (
          <GanttChart
            projects={[project]}
            spaceId={spaceId}
            customFields={space?.custom_fields_schema}
            activeTaskId={taskId}
            onTaskClick={openTask}
            onReschedule={reschedule}
          />
        ) : (
          <p className="panel text-center text-sm text-text-muted">
            No shop floor tasks loaded for this project yet. Import its Gantt PDF with cli_import.py.
          </p>
        ))}
    </div>
  );
}
