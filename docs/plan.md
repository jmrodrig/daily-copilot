# Daily Co-Pilot System — Project Plan

Sep 30, 2026 · Jose

## Problem

Jose works as a naval architect across two main projects (C7801 and R5301) plus a third, P5002, which is not a main project but which he supports mainly on certification (RCD), in an environment where requests arrive from all directions (internal email, external email, verbal handoffs, meetings) with no single gatekeeper triaging them first. All three projects (C7801, R5301 and P5002) have a Gantt chart, but each is set once and rarely consulted; in practice, whoever asks loudest gets priority. A rough gut-check put a typical day at 50% real project work and 50% firefighting or ad hoc requests. Verbal and meeting inputs get jotted in a notebook or Google Keep but are often buried and forgotten rather than acted on. Jose can protect blocks on his calendar and people generally respect them, but incoming requests have no clean "holding bucket" to wait in, so they pile up or vanish.

## Goal

Build a personal AI co-pilot that runs Jose's day from the actual project plans rather than from whoever shouts loudest. Each morning it produces a ranked task list, weighted against the Gantt charts, milestones and objectives of all three projects (C7801 and R5301 as the main projects, P5002 for certification support), and refined over time by what Jose actually completes versus defers. Each evening, ticking off finished tasks both closes the loop for tomorrow's ranking and doubles as time-tracking data. The system also prepares briefs ahead of meetings and keeps a running thread of notes per meeting series, and it surfaces a weekly view of time spent on project work versus ad hoc noise — useful for Jose's own planning and as evidence for the wider planning problem on the project.

## System components

| Component | What it does | Notes |
| --- | --- | --- |
| Capture app | Lightweight app for logging ad hoc inputs in the moment — verbal handoffs, meeting notes, hallway requests — tagged by project and priority | Replaces the notebook/Keep habit where items get buried |
| Email intake | Jose forwards relevant emails (internal or external) to a dedicated address the agent can read, with a short note on priority and project | Workaround for email access constraints; manual forwarding, kept deliberately narrow |
| Daily triage engine | Pulls capture app entries, forwarded emails, and all three Gantt charts/milestones; ranks tasks each morning; adjusts ranking based on completion history | The core engine — turns "loudest voice wins" into "does this serve the plan" |
| Evening check-in | Jose ticks off completed tasks; feeds tomorrow's ranking and doubles as a timesheet entry | Removes the need to separately reconstruct the week for timesheets |
| Meeting prep briefs | For recurring meetings, pulls prior notes and open items, checks them against current project status, and produces a short prep brief with a structured place to add live notes | One-off meetings get a lighter version; notes feed back into that meeting's ongoing thread |
| Weekly rollup | Shows time spent on project work vs. ad hoc/reactive work, doubling as a pre-filled timesheet | Also useful as evidence of the planning gap on the wider project |
| Version history | Unified audit trail capturing full snapshots and the "source" (actor/model) for every change to DB rows and notes | Essential for safe agent edits; provides full undo, timeline views, and certification traceability |

## Daily loop

[Diagram not included in this export: "daily loop — inputs, triage, ranked list, feedback". It shows capture app entries, forwarded email and all three Gantt charts feeding the triage engine, which produces the morning ranked list; the evening check-in feeds completion history back into tomorrow's ranking.]

Capture app entries, forwarded email, and all three Gantt charts all feed the triage engine, which produces the morning's ranked list. The evening check-in closes the loop, feeding completion history back into tomorrow's ranking, and also populates the weekly rollup and meeting prep briefs.

## Platform and architecture

Three surfaces share one backend, which runs on Jose's work computer — home of the triage engine, the Gantt and project data, and the email intake. A native Android app handles on-the-go capture, chosen over a PWA for reliable background capture, timely evening check-in notifications, and share-sheet integration so a note or email can be shared straight into the capture app from anywhere on the phone. A browser-based desktop app provides the dashboard, a conversational query interface over the project database, meeting prep requests, and notes entry. Jose's work machine is always on, so the backend is reachable around the clock. The Android app reaches it over Tailscale, which Jose already uses reliably for other things, rather than exposing anything publicly.

The desktop app's knowledge base is organised Confluence-style: pages per project aspect or per meeting, created on demand. On a meeting's page, Jose can ask the co-pilot to draft the prep brief directly into the page's structure, then take live notes topic by topic against it. An explicit "publish" action, rather than silent background ingestion, is the moment those notes actually get folded into the knowledge base — keeping Jose in control of what counts as settled versus still a draft.

The dashboard renders its own live, interactive Gantt view from the extracted plan data rather than showing the PDF — the actual chart Jose checks day to day, replacing the static export that gets set once and forgotten.

Both the Android app and the desktop app should be built dark-mode by default, matching Jose's preference.

The wiki includes a Forwarded emails section: every email Jose forwards to the agent is archived there, with his short priority and project note, filed by project and searchable, so it can be consulted later and linked from related project and meeting pages. The triage engine reads from the same archive.

The wiki also has an Obsidian-style notes graph. Jose picks a tag and sees every note attached to it as a cluster, with related tags linking clusters together, and can filter by boat, project or note type (design note, meeting, forwarded email, reference). Clicking a note previews it. The main use case is reuse: before designing a fitting or detail from scratch, check what was done on previous boats and pull it into the current project.

Every note is a markdown file with properties at the top, and can hold images, tables, checklists and embedded widgets (live Gantt, task list, time split, forwarded email, graph). New pages start from templates: meeting, design artifact, quick note, new task, design decision and email note. The meeting template is filled in automatically by meeting prep with the brief: carried-over items, plan check, related emails and agenda.

Tasks can have subtasks, each with its own estimate and due date. The triage engine schedules and ranks the individual subtasks against the Gantt data, not just the parent task. The page tree is compact and every folder collapses, and both the tree and the chat pane collapse to a slim rail.

Every task in the Gantt charts is a production or shop floor task, so Jose's own tasks are design tasks that link to them. A design task can be linked to the shop floor tasks it blocks as a finish-to-start dependency, and each link shows how many days of float remain before the shop floor task starts. The dashboard Gantt draws shop floor tasks with the linked design tasks in amber beneath them, joined by a dashed dependency line. The triage engine ranks design tasks, and their subtasks, by the start date of the shop floor task they block, so the plan drives priority rather than whoever asks loudest.

A People section holds characters Jose creates as labels, such as a yard foreman, class surveyor or loft lead, each with a role or group. Tasks and subtasks can be assigned to a character, and each meeting note records which characters were present or absent. Characters are purely a personal tool and are not linked to real accounts or email addresses.

**Today, All tasks and task pages.** Today is only the plan for the day: a timeline of scheduled blocks plus a short Coming up list. All tasks is a separate page with a table (rank, project, due, the Gantt task it blocks, assignee). Every task is a markdown page whose header holds all metadata (type, project, status, due, estimate, assignee, scheduled slot, blocks, parent). Subtasks are child pages under their parent in the tree; they link back to the parent automatically and appear in the parent's Subtasks section without manual entry. The agent schedules each subtask separately. Tree rows show add (new note or subtask) and delete buttons only on hover or keyboard focus.

**Projects and per-project Gantt.** The page tree has a NOTES section whose first level is always a project (C7801, R5301, P5002 for certification support, plus an Inbox for unsorted items). A Project template creates a project with its overview and milestones, and scaffolds a Plan (Gantt) page and Tasks, Meetings, Design and Forwarded emails folders. The Gantt is a special page type, one per project, that can be added anywhere under a project from the template gallery; it shows only that project's shop floor tasks and the design tasks linked to them. Templates and the Reference library sit in a separate LIBRARY section below the notes.

**Agent access and model choice.** The co-pilot reads every note under Notes and Library and can write to Notes through the same file layer the editor uses, with an access mode per user: Read only, Ask first (proposed edits wait for approval) or Write directly. Every agent edit is kept in the note's history and can be undone. The model is selectable in the chat pane: Gemini 3.1 is the default (API key already held), with slots for Claude, OpenAI and a local model served by Ollama or LM Studio on the work PC. To decide during implementation: put the model behind a provider-agnostic adapter with tool calling, so note read and write tools work the same on every provider; keep Gemini as the default for long-context wiki questions and brief drafting; use a local model for confidential client or class documents that must not leave the work PC; and treat Claude or OpenAI as optional alternatives for the multi-step note-editing flows, which should be compared on real tasks before choosing a second default.

**Notes-in folder.** Every project has a fixed Notes-in folder as the default landing place for notes that are not organised yet: quick notes, voice captures from the Android app, and pages created from a project's + button. Notes can stay there indefinitely. When asked, the co-pilot chunks them into tasks, design notes, decisions or meeting notes and moves them into the right folder, with the same approve-or-write-directly control as other agent edits.

**Attachments, annotations and comments (planned feature).** Any note can hold uploaded or pasted PDFs and images, open them inline, and be marked up with pen or mouse scribbles and comments.

- Adding files: upload, drag and drop, or paste from the clipboard (screenshots, CAD exports). Files are stored next to the note in the project's attachments folder; the note holds only a reference, so the original is never altered.
- Viewing: images open inline with zoom; PDFs open in an inline page viewer with page navigation and full-screen mode.
- Annotation tools: pen, highlighter, eraser, a small colour palette and line widths. Input works with mouse, touch and the stylus on the Android app, using pointer events with pressure where available.
- Annotation storage: strokes are saved as vector data in a sidecar file per attachment and page, using coordinates relative to the page so they stay aligned at any zoom. Annotations can be shown, hidden or exported as a flattened PDF or image.
- Comments: pin a comment to a point, a region or a text selection on an image or PDF page, with threads and a resolved state. Notes also support comments on text, as in the floating toolbar.
- Agent access: the co-pilot reads the extracted PDF text (with OCR for scans) and every comment and annotation label, so they are searchable and can feed meeting briefs and tasks. Turning a comment into a task is one action.
- Open decisions for implementation: the PDF renderer (PDF.js is the likely choice), the annotation data format, OCR engine, and whether comments sync live between devices or on save.

**Version history tracking.** Every entity (database rows like Tasks and Links, and file-based Notes and Emails) has full version history recorded in a central SQLite `history` table. Every change captures the source (e.g., manual edit, Gemini, email capture) and a full JSON snapshot of the entity, ensuring older snapshots remain readable even if schemas evolve. To guarantee complete coverage without bypassing the history log, all deletions are handled via application-level soft deletes rather than database-level cascades, and file renames are logged explicitly as a "rename" action.

## Constraints and workaround

Direct, automatic access to Jose's work inbox is not straightforward given current IT/system constraints. The agreed workaround: Jose manually forwards only the emails that matter to a dedicated address the agent can read, adding a short note on priority and project. This keeps the system's access narrow and deliberate rather than reading the full inbox, at the cost of an extra manual step. For now the volume is manageable; if forwarding becomes a bottleneck or emails start going unforwarded, it's worth revisiting (a forwarding rule, a shared label, or a reminder habit).

## Build phases

1. Load all three Gantt charts (C7801, R5301 and P5002): Jose provides the current PDF exports, one per project, which get parsed into structured data (tasks, dates, dependencies, milestones and objectives) the triage engine can check requests against.
2. Implement version history tracking: Set up the unified SQLite history table and intercept all write paths (DB events and file saves) to capture full snapshots and the "source" actor. Introduce application-level soft-deletes and file rename actions. Doing this now ensures the audit trail is ready before agents and pipelines begin writing data.
3. Stand up the capture app — a minimal, fast-to-use logging tool for verbal and meeting inputs, tagged by project and priority. This alone fixes the "buried and forgotten" problem and is useful even before anything else exists.
4. Set up the dedicated forwarding address and a simple tagging convention for forwarded emails.
5. Build the daily triage engine: pull capture app entries + forwarded emails + plan data, produce a ranked morning list.
6. Add the evening check-in, tying completed tasks back into tomorrow's ranking and logging time per project.
7. Add meeting prep briefs, starting with recurring meetings — pulling prior notes and open items, with a structured place for live notes that feed back into that meeting's thread.
8. Add the weekly rollup: time split between project work and ad hoc work, doubling as a pre-filled timesheet.

Each phase is usable on its own, so the system delivers value from phase 1 rather than waiting on the full build.

## Open questions and risks

The ranking logic should stay anchored mainly to the Gantt charts and deadlines, with completion history used only as a light tiebreaker — otherwise it risks learning to rank the things Jose already tends to defer as permanently low priority, reinforcing avoidance rather than correcting it.

Manual email forwarding and manual capture-app entry are both good starting points, but both depend on Jose remembering to use them in the moment; worth checking after a few weeks whether either has quietly reverted to the old notebook problem.

Still open: whether meeting notes stay fully manual or move toward a listening mode later, as discussed. Also still open: how bulk reference material gets into the knowledge base — RCD norms, ISO standards, boat data sitting in PDFs, Excel sheets and Word documents. The likely shape is an ingestion pipeline: each file type parsed into text or structured data, then chunked and indexed so the query interface can retrieve relevant pieces on demand, rather than a single upload flow that treats every format the same. Needs designing rather than assumed.
