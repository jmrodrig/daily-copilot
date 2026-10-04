import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import GanttChart, { type GanttProject } from "../components/GanttChart";
import { getJson, message } from "../lib/api";
import { useSpace } from "../lib/space";
import PageHeader from "../components/PageHeader";

type State = { state: "loading" } | { state: "ok"; project: GanttProject | null } | { state: "error"; message: string };

/** One project's shop floor Gantt (`/plan/:code`). */
export default function ProjectPlan() {
  const { code = "" } = useParams();
  const [gantt, setGantt] = useState<State>({ state: "loading" });
  const { spaceId } = useSpace();

  useEffect(() => {
    const controller = new AbortController();
    setGantt({ state: "loading" });
    getJson<{ projects: GanttProject[] }>(`/api/gantt?space_id=${spaceId}`, controller.signal)
      .then((body) =>
        setGantt({ state: "ok", project: body.projects.find((p) => p.code.toLowerCase() === code.toLowerCase()) ?? null }),
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setGantt({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [code, spaceId]);

  const project = gantt.state === "ok" ? gantt.project : null;
  return (
    <div className="flex flex-col gap-5 px-9 py-7">
      <PageHeader eyebrow={`${code.toUpperCase()} · PLAN`} title={project?.name || code} subtitle="Shop floor Gantt" />
      {gantt.state === "loading" && <p className="text-[13px] text-text-muted">Loading the Gantt…</p>}
      {gantt.state === "error" && (
        <p className="text-[13px] text-text-secondary">Could not load the Gantt ({gantt.message}).</p>
      )}
      {gantt.state === "ok" &&
        (project && project.tasks.length > 0 ? (
          <GanttChart projects={[project]} />
        ) : (
          <p className="panel text-center text-sm text-text-muted">
            No shop floor tasks loaded for this project yet. Import its Gantt PDF with cli_import.py.
          </p>
        ))}
    </div>
  );
}
