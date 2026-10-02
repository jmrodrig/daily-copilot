# Daily Co-Pilot System — Project Plan

## 1. Functional Requirements
A personal AI co-pilot designed to manage daily workflows against real project Gantt charts (C7801, R5301, P5002) rather than ad hoc urgency.
- **Capture App (Android):** Fast logging of ad hoc inputs, tagged by source/project/priority.
- **Email Intake:** Automated saving of relevant emails to a markdown drop folder, tagged by priority and project.
- **Daily Triage Engine:** Ranks tasks and subtasks daily based on Gantt data, float, and recent completion history.
- **Evening Check-in:** Closes the loop, updates tomorrow's ranking, and logs time.
- **Meeting Prep Briefs:** Consolidates prior notes, plan checks, and open items for recurring meetings.
- **Weekly Rollup:** Pre-fills timesheets and separates project work from ad hoc noise.
- **Knowledge Base:** Markdown-backed wiki with templates, notes graph, and forwarded email archive.
- **Co-Pilot Chat:** Conversational agent reading/writing the knowledge base with per-user access modes (Read only, Ask first, Write directly).

## 2. Phase Status
- **Phase 0 — Foundations:** **Complete**
- **Phase 1 — Gantt Ingestion:** **In Progress**
- **Phase 2 — Capture App:** Pending
- **Phase 3 — Email Intake:** Pending
- **Phase 4 — Desktop App Core:** Pending
- **Phase 5 — Triage Engine:** Pending
- **Phase 6 — Evening Check-in:** Pending
- **Phase 7 — Co-pilot Chat and Agent:** Pending
- **Phase 8 — Meeting Prep Briefs:** Pending
- **Phase 9 — Weekly Rollup:** Pending
- **Phase 10 — Annotations & Bulk Ingestion:** Pending

## 3. Pending Decisions
- None currently.

## 4. Open Risks
- **Behavioral Reversion:** Reliance on Jose manually capturing/forwarding tasks. Need to monitor if this reverts to the old notebook habit.
- **Ranking Drift:** Risk of the engine learning to bury tasks that are habitually deferred. Completion history must remain a *light tiebreaker* only.
- **Bulk Ingestion Pipeline:** Technical design for ingesting PDFs/Excel/Word reference materials is still high-level and needs refinement in Phase 10.
- **Meeting Notes:** Future evolution from manual entry to automated listening mode remains to be investigated.

## 5. Deviations Log
- **2026-10-02:** *Email Intake (Phase 3) modified.* Switched from dedicated email forwarding/IMAP polling to a local automation that saves emails directly to a markdown drop folder. (Decision 6 updated).
