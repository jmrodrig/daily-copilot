"""Gantt PDF parsing pipeline: PDF text (PyMuPDF) -> structured JSON (LLM via litellm).

The Gantt PDFs are visual exports. Some list start/end dates per task, others only
draw bars under a weekly date header, so each text line is sent with its page
coordinates: the model matches a bar label's x-position against the header dates.

The result is a draft for human review; nothing here writes to the database.
"""

import json
import re
import datetime as dt
from pathlib import Path
from typing import Any

import litellm
import pymupdf
from pydantic import BaseModel, Field, ValidationError, model_validator

from config import Settings, get_settings
from schemas import LinkType

SYSTEM_PROMPT = """\
You extract structured schedule data from the text of a project Gantt chart PDF export.

The input is the PDF's text, one line per text span, formatted as
`[x0-x1, y] text` where x0/x1 are the left/right edges and y the vertical centre
in PDF points (origin top-left). Pages are separated by `=== Page N ... ===` headers.

How to read the chart:
- Each task row has a name in the left-hand columns. If the row has explicit start
  and end date columns, use those dates.
- Otherwise derive the dates from the bar: text on the same row (same y, within a
  few points) to the right of the task name is the bar, usually labelled with the
  trade. Map the bar's leftmost x0 and rightmost x1 to dates using the weekly date
  header along the top of the chart (each header date marks the start of a week
  column). Repeated labels on one row are one continuous bar.
- Dates in the PDF are day-first (DD/MM/YYYY). `########` is a truncated cell; ignore it.
- Section headings (e.g. "Superstructure & deck", "High level build stage") group
  the tasks below them; report the heading as the task's `parent`.
- Milestones are zero-duration events such as "STAGE PAYMENT - ...", launch or
  handover markers. List them under `milestones`, not `tasks`.
- Dependencies are finish-to-start links: the predecessor must finish before the
  successor starts. Only report a dependency when the chart states it or the
  sequence is unambiguous (the successor starts when the predecessor ends and
  clearly relies on it, e.g. "Keel delivery" before "Keel install"). Do not guess.

Respond with ONLY a single valid JSON object, no markdown fences or commentary,
matching exactly this shape:
{
  "project_code": "string or null, e.g. C7801",
  "project_name": "string or null",
  "tasks": [
    {
      "id": "T1",
      "name": "task name",
      "parent": "section heading or null",
      "trade": "trade / resource or null",
      "start": "YYYY-MM-DD or null",
      "end": "YYYY-MM-DD or null",
      "percent_complete": "number 0-100 or null"
    }
  ],
  "dependencies": [
    {"predecessor": "T1", "successor": "T2", "type": "finish_to_start", "lag_days": 0}
  ],
  "milestones": [
    {"name": "milestone name", "date": "YYYY-MM-DD or null"}
  ]
}
Task ids must be unique ("T1", "T2", ...) and dependencies must reference them.
Use null for any value you cannot determine; never invent dates."""

_FENCE_RE = re.compile(r"\A\s*```(?:json)?\s*(.*?)\s*```\s*\Z", re.DOTALL)


class GanttParseError(Exception):
    """The PDF could not be read or the model did not return usable JSON."""


class GanttTask(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    parent: str | None = None
    trade: str | None = None
    start: dt.date | None = None
    end: dt.date | None = None
    percent_complete: float | None = Field(default=None, ge=0, le=100)


class GanttDependency(BaseModel):
    predecessor: str
    successor: str
    type: LinkType = LinkType.FINISH_TO_START
    lag_days: float = 0


class GanttMilestone(BaseModel):
    name: str = Field(min_length=1)
    date: dt.date | None = None


class GanttExtraction(BaseModel):
    project_code: str | None = None
    project_name: str | None = None
    tasks: list[GanttTask] = Field(default_factory=list)
    dependencies: list[GanttDependency] = Field(default_factory=list)
    milestones: list[GanttMilestone] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_references(self) -> "GanttExtraction":
        ids = [task.id for task in self.tasks]
        if len(ids) != len(set(ids)):
            raise ValueError("task ids must be unique")
        known = set(ids)
        for dep in self.dependencies:
            if dep.predecessor not in known or dep.successor not in known:
                raise ValueError(
                    f"dependency {dep.predecessor} -> {dep.successor} references an unknown task"
                )
        return self


def extract_pdf_text(pdf_path: str | Path) -> str:
    """Return the PDF's text, one `[x0-x1, y] text` line per span, in reading order."""
    path = Path(pdf_path)
    if not path.is_file():
        raise FileNotFoundError(f"Gantt PDF not found: {path}")
    try:
        doc = pymupdf.open(path)
    except Exception as exc:
        raise GanttParseError(f"Could not open {path} as a PDF: {exc}") from exc

    pages = []
    span_count = 0
    with doc:
        for number, page in enumerate(doc, start=1):
            spans = []
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        text = span["text"].strip()
                        if text:
                            x0, y0, x1, y1 = span["bbox"]
                            spans.append((round((y0 + y1) / 2), round(x0), round(x1), text))
            spans.sort()
            span_count += len(spans)
            lines = [f"[{x0}-{x1}, {y}] {text}" for y, x0, x1, text in spans]
            header = f"=== Page {number} ({round(page.rect.width)}x{round(page.rect.height)} pt) ==="
            pages.append("\n".join([header, *lines]))

    text = "\n\n".join(pages)
    if not any(page.count("\n") for page in pages):
        raise GanttParseError(f"No text found in {path}; scanned PDFs are not supported")
    return text


def parse_llm_json(content: str | None) -> dict[str, Any]:
    """Validate the model's reply and return it as a JSON-ready dict."""
    if not content:
        raise GanttParseError("The model returned an empty response")
    match = _FENCE_RE.match(content)
    if match:
        content = match.group(1)
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise GanttParseError(f"The model did not return valid JSON: {exc}") from exc
    try:
        extraction = GanttExtraction.model_validate(raw)
    except ValidationError as exc:
        raise GanttParseError(f"The model's JSON does not match the Gantt schema: {exc}") from exc
    return extraction.model_dump(mode="json")


def extract_gantt_data(pdf_path: str, settings: Settings | None = None) -> dict:
    """Extract tasks, dates, dependencies and milestones from a Gantt PDF."""
    settings = settings or get_settings()
    if settings.gemini_api_key is None:
        raise GanttParseError("COPILOT_GEMINI_API_KEY is not set; add it to backend/.env")

    text = extract_pdf_text(pdf_path)
    response = litellm.completion(
        model=settings.gantt_model,
        api_key=settings.gemini_api_key.get_secret_value(),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Gantt PDF: {Path(pdf_path).name}\n\n{text}"},
        ],
        response_format={"type": "json_object"},
    )
    return parse_llm_json(response.choices[0].message.content)
