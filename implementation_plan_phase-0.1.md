# Implementation Plan: Phase 0.1 - Foundation and Repo Structure
**Task ID:** phase-0.1

## Goal
Initialize the foundational repository structure, set up the shared design tokens from the mockups, and configure the basic CI/test tooling.

## Scope
- Create the core directory structure (`backend/`, `desktop/`, `android/`, `shared/`, `docs/decisions/`).
- Extract colors, typography, and spacing from the provided mockup specifications into a shared design tokens file.
- Initialize basic linting and test configuration placeholders for the Python backend and React desktop app.

## Relevant Context
From `plan.md`:
> "Dark, calm, engineering-tool feel. Background #0C1216, raised surface #131B21, panel #0F171C, border #25323B / #2F3E48. Text #E8EEF1 primary, #C5D0D6 secondary, #97A5AE muted. Accent amber #F2B544... Project colours: #6CB6EA, #B7A3F2, #56C8A8; ad hoc / neutral #6B7A84. Type: IBM Plex Sans (UI) and IBM Plex Mono (dates, ranks, numbers)."

## Files to Modify / Create
- `/shared/design-tokens.json` (New)
- `/.gitignore` (New)
- `/backend/pytest.ini` (New)
- `/desktop/package.json` (New, stub for testing/linting configs)
- Directory structure creation.

## Interfaces
- Design tokens must be in a format consumable by both Tailwind CSS (desktop) and Jetpack Compose (Android). A structured JSON file is required.

## Constraints
- No external libraries to be installed yet beyond scaffolding.
- Do not execute destructive commands or touch anything outside the repository.
- Keep the design token naming semantic (e.g., `color-surface-raised`, `color-accent-primary`).

## User-Driven Manual Test Plan
1. Open the project root in your file explorer.
2. Verify that the `backend`, `desktop`, `android`, and `shared` directories exist.
3. Open `shared/design-tokens.json` and verify the hex codes match the ones defined in Section 4 of the original plan.
4. Run `pytest backend/` (if pytest is available locally) to ensure the backend testing skeleton is correctly identified, expecting 0 tests to run without errors.

## Out of Scope
- Implementing the actual FastAPI backend or React app.
- Tailscale setup or database configuration (handled in Phase 0.3).
