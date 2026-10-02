"""Terminal review step for Gantt PDFs: extract, show the result, import on approval.

Usage (from backend/):

    python cli_import.py "../docs/gantt/C7801 Project Plan.pdf"

Re-importing a project replaces all of its Gantt tasks (and their links); tasks
created outside the Gantt (`is_gantt_task=False`) are left alone.
"""

import argparse
import datetime as dt
import json
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from gantt_parser import GanttParseError, extract_gantt_data
from models import Link, Project, Task
from schemas import LinkType, Status

PROMPT = "Approve and import to database? [Y/N] "
_PROJECT_CODE_RE = re.compile(r"\b([A-Z]\d{4})\b")


@dataclass
class ImportResult:
    project_code: str
    created_project: bool
    replaced_tasks: int
    tasks: int
    milestones: int
    links: int


def resolve_project_code(data: dict, pdf_path: str | Path) -> str | None:
    """Prefer the code the model found; fall back to one in the file name (e.g. C7801)."""
    code = (data.get("project_code") or "").strip()
    if code:
        return code
    match = _PROJECT_CODE_RE.search(Path(pdf_path).stem.upper())
    return match.group(1) if match else None


def summarize(data: dict, project_code: str | None) -> str:
    tasks = data.get("tasks", [])
    starts = [t["start"] for t in tasks if t.get("start")]
    ends = [t["end"] for t in tasks if t.get("end")]
    undated = sum(1 for t in tasks if not t.get("start") or not t.get("end"))
    lines = [
        f"Project code:  {project_code or '(unknown)'}",
        f"Project name:  {data.get('project_name') or '(unknown)'}",
        f"Tasks:         {len(tasks)}" + (f" ({undated} missing start/end)" if undated else ""),
        f"Milestones:    {len(data.get('milestones', []))}",
        f"Dependencies:  {len(data.get('dependencies', []))}",
    ]
    if starts and ends:
        lines.append(f"Date range:    {min(starts)} to {max(ends)}")
    return "\n".join(lines)


def confirm(prompt: str = PROMPT, input_fn: Callable[[str], str] = input) -> bool:
    """Ask until the answer is Y or N; end of input counts as No."""
    while True:
        try:
            answer = input_fn(prompt).strip().lower()
        except EOFError:
            return False
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("Please answer Y or N.")


def _date(value: str | None) -> dt.date | None:
    return dt.date.fromisoformat(value) if value else None


def _status(percent_complete: float | None) -> Status:
    if percent_complete is None or percent_complete <= 0:
        return Status.TODO
    return Status.DONE if percent_complete >= 100 else Status.IN_PROGRESS


def _description(task: dict) -> str:
    parts = []
    if task.get("parent"):
        parts.append(f"Section: {task['parent']}")
    if task.get("trade"):
        parts.append(f"Trade: {task['trade']}")
    if task.get("percent_complete") is not None:
        parts.append(f"Complete: {task['percent_complete']:g}%")
    return "\n".join(parts)


def import_gantt(session: Session, data: dict, project_code: str) -> ImportResult:
    """Upsert the project and replace its Gantt tasks, milestones and links.

    The caller owns the transaction: commit on success, roll back on error.
    """
    project = session.scalar(select(Project).where(Project.code == project_code))
    created_project = project is None
    if project is None:
        project = Project(code=project_code, name=data.get("project_name") or project_code)
        session.add(project)
        session.flush()
    elif data.get("project_name"):
        project.name = data["project_name"]

    # Links to the old tasks go with them via ON DELETE CASCADE.
    replaced = session.execute(
        delete(Task).where(Task.project_id == project.id, Task.is_gantt_task.is_(True))
    ).rowcount

    by_gantt_id: dict[str, Task] = {}
    for item in data.get("tasks", []):
        task = Task(
            project_id=project.id,
            title=item["name"],
            description=_description(item),
            status=_status(item.get("percent_complete")),
            start_date=_date(item.get("start")),
            deadline=_date(item.get("end")),
            is_gantt_task=True,
        )
        session.add(task)
        by_gantt_id[item["id"]] = task

    milestones = data.get("milestones", [])
    for item in milestones:
        day = _date(item.get("date"))
        session.add(
            Task(
                project_id=project.id,
                title=item["name"],
                start_date=day,
                deadline=day,
                is_gantt_task=True,
                is_milestone=True,
            )
        )
    session.flush()

    seen: set[tuple[str, str]] = set()
    for dep in data.get("dependencies", []):
        pair = (dep["predecessor"], dep["successor"])
        if pair in seen or pair[0] == pair[1]:
            continue
        seen.add(pair)
        session.add(
            Link(
                predecessor_id=by_gantt_id[pair[0]].id,
                successor_id=by_gantt_id[pair[1]].id,
                type=LinkType(dep.get("type") or LinkType.FINISH_TO_START),
                lag_days=dep.get("lag_days") or 0,
            )
        )
    session.flush()

    return ImportResult(
        project_code=project_code,
        created_project=created_project,
        replaced_tasks=replaced,
        tasks=len(by_gantt_id),
        milestones=len(milestones),
        links=len(seen),
    )


def main(
    argv: list[str] | None = None,
    input_fn: Callable[[str], str] = input,
    session_factory: Callable[[], Session] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description="Review a Gantt PDF extraction and import it.")
    parser.add_argument("pdf", help="Path to the Gantt PDF export")
    parser.add_argument("--code", help="Project code to import under (overrides the extracted one)")
    args = parser.parse_args(argv)

    # Windows consoles may not encode every character the PDF contains.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    print(f"Extracting {args.pdf} ...")
    try:
        data = extract_gantt_data(args.pdf)
    except (FileNotFoundError, GanttParseError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    project_code = args.code or resolve_project_code(data, args.pdf)
    print(json.dumps(data, indent=2, ensure_ascii=False))
    print()
    print(summarize(data, project_code))
    print()

    if not project_code:
        print("Error: no project code found; re-run with --code C7801 (for example).", file=sys.stderr)
        return 1
    if not confirm(input_fn=input_fn):
        print("Import cancelled; nothing was written.")
        return 0

    if session_factory is None:
        from database import SessionLocal, init_db

        init_db()
        session_factory = SessionLocal

    with session_factory() as session, session.begin():
        result = import_gantt(session, data, project_code)

    action = "Created" if result.created_project else "Updated"
    print(
        f"{action} project {result.project_code}: imported {result.tasks} tasks, "
        f"{result.milestones} milestones and {result.links} links"
        + (f" (replaced {result.replaced_tasks} previous Gantt tasks)." if result.replaced_tasks else ".")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
