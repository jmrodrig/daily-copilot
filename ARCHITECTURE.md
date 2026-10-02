# Architecture

## 1. System Overview
The Daily Co-Pilot is a local-first system designed to manage naval architecture projects by anchoring daily tasks to shop floor Gantt schedules. It operates across three main components connected over a Tailscale private network.

### Components
1. **Backend (Python / FastAPI):** Runs locally on the work PC. Handles the daily triage engine, LLM provider integration, markdown file management, structured SQLite data, and serves the REST API.
2. **Desktop Web App (React / Vite / Tailwind CSS):** Browser-based dashboard providing interactive Gantt views, markdown editing, task management, and an AI chat pane.
3. **Android App (Kotlin / Jetpack Compose):** Native mobile app for quick capture, daily morning/evening check-ins, and share-sheet integration.

## 2. Networking and Security
- **Network:** All communication occurs over Tailscale. No public endpoints.
- **Authentication:** Simple static device tokens (API keys) to authenticate the Android app and Desktop client with the local backend.
- **Data Privacy:** All project data and embeddings remain on the local work PC. Cloud LLM APIs (Gemini) are used for specific generation tasks, but confidential documents can be routed to local models (Ollama).

## 3. Data Model
- **Structured Data (SQLite):**
  - **Tasks & Subtasks:** Status, estimates, deadlines, ranking float.
  - **Links:** Finish-to-start dependencies connecting design tasks to shop floor Gantt tasks.
  - **Captures:** Quick notes ingested from the mobile app.
  - **Completion Log:** Daily history of closed tasks for timesheets and rank weighting.
- **File Data (Markdown File Layer):**
  - **Notes & Wiki:** Confluence-style project pages, meeting notes, design decisions (with front-matter metadata).
  - **Emails:** Ingested markdown representations of forwarded emails.
  - **Attachments/Annotations:** PDFs and images with JSON sidecars for vector annotations.

## 4. ADR Index (Architecture Decision Records)
1. **Backend Stack:** Python (FastAPI) + SQLite + Markdown file tree.
2. **Desktop Stack:** React (Vite) + Tailwind CSS.
3. **Mobile Stack:** Native Android (Kotlin / Jetpack Compose).
4. **API Interface:** REST API with static device tokens.
5. **Search/Retrieval:** Local BM25 (keyword) + Local Embeddings (SentenceTransformers/ChromaDB).
6. **Email Intake:** File-based drop folder for emails saved as markdown (via local automation), bypassing IMAP polling.
7. **Gantt PDF Extraction:** PyMuPDF + Gemini Pro API parsing to structured JSON, with manual UI review.
8. **Model Adapter:** LiteLLM for standardized tool calling across Gemini, Claude, and Ollama.
9. **Annotations & PDFs:** PDF.js rendering, JSON sidecars for vector scribbles, Tesseract for local OCR, sync-on-save.
10. **Bulk Reference Ingestion:** Unstructured.io for chunking complex documents into markdown for the local vector DB.
