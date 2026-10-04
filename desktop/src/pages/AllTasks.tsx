import TriageBoard from "../components/TriageBoard";
import PageHeader from "../components/PageHeader";

export default function AllTasks() {
  return (
    <div className="flex max-w-5xl flex-col gap-5 px-9 py-7">
      <PageHeader
        title="Triage"
        subtitle="Active Gantt tasks and captured notes, most urgent first. Claim a task to put it on your day."
      />
      <TriageBoard />
    </div>
  );
}
