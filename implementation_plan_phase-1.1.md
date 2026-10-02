# Implementation Plan: Phase 1.1 - Gantt PDF Parsing Pipeline
**Task ID:** phase-1.1

## Goal
Build the extraction pipeline using `PyMuPDF` to read Gantt PDFs and `litellm` (calling Gemini) to convert the unstructured text into a structured JSON representation of tasks, dates, dependencies, and milestones.

## Scope
- Create `backend/gantt_parser.py` with a main function `extract_gantt_data(pdf_path: str) -> dict`.
- Use `PyMuPDF` to extract the raw text from the provided Gantt PDF.
- Use `litellm` (with the `gemini-3.1-pro` model) to parse that text into structured JSON. The prompt must instruct the model to extract tasks, start/end dates, finish-to-start dependencies, and milestones.
- Update `backend/requirements.txt` with `pymupdf` and `litellm`.
- Create `backend/tests/test_gantt_parser.py` that tests the pipeline. **Crucial:** Mock the `litellm.completion` call in the tests so we do not make real API calls or require an API key during automated CI runs.

## Relevant Context
- The extracted JSON should align with the domain model we established in `schemas.py` (e.g., tasks having a name, start, end, and parent/dependencies).
- The LLM step is necessary because the PDFs are visual Gantt exports, making standard regex extraction brittle.
- Do not build the UI for the human-review step yet; this phase is strictly the backend extraction pipeline.

## Files to Modify / Create
- `backend/gantt_parser.py` (New)
- `backend/tests/test_gantt_parser.py` (New)
- `backend/requirements.txt` (Modify)
- `backend/config.py` (Modify to ensure the Gemini API key is loaded)

## Interfaces
- `extract_gantt_data(pdf_path: str) -> dict`

## Constraints
- Ensure the prompt demands valid JSON.
- Never hardcode the API key; it must be loaded from `config.py`.

## User-Driven Manual Test Plan
1. Open PowerShell in `C:\Users\designer\Documents\assistant\copilot\backend`.
2. Add your Gemini API key to `backend/.env` as `COPILOT_GEMINI_API_KEY=your_key_here`.
3. Run `pip install -r requirements.txt`.
4. Open an interactive Python shell (`python`) and run:
   ```python
   from gantt_parser import extract_gantt_data
   data = extract_gantt_data("../docs/gantt/C7801 Project Plan.pdf")
   print(data["tasks"][:2])
   ```
5. Verify that it successfully prints extracted task data with dates.

## Out of Scope
- The frontend UI for reviewing and diffing the extracted data.
- Connecting the output directly into the database (we need the review step first).
