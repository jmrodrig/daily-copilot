# Daily Co-Pilot Backend

Local FastAPI service backed by SQLite. It runs on the work PC and is reachable
from the Android app only over Tailscale — there are no public endpoints.

## Setup

Requires Python 3.11+. From this `backend/` directory (PowerShell):

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt        # runtime
pip install -r requirements-dev.txt    # + pytest/httpx for tests
```

## Configuration

Settings are read from system environment variables and from `backend/.env`
(environment variables win). All names use the `COPILOT_` prefix:

| Variable                    | Default                  | Notes                                             |
|-----------------------------|--------------------------|---------------------------------------------------|
| `COPILOT_DB_PATH`           | `copilot.db`             | Relative paths resolve against `backend/`         |
| `COPILOT_NOTES_DIR`         | `notes`                  | Markdown notes root; relative to `backend/`       |
| `COPILOT_HOST`              | `127.0.0.1`              | Used by `python main.py`                          |
| `COPILOT_PORT`              | `8000`                   | Used by `python main.py`                          |
| `COPILOT_OLLAMA_BASE_URL`   | `http://localhost:11434` | Local model endpoint                              |
| `COPILOT_GANTT_MODEL`       | `gemini/gemini-3.1-pro-preview` | litellm model for the Gantt PDF parser     |
| `COPILOT_GEMINI_API_KEY`    | unset                    | Needed by the Gantt parser; never hardcode or commit |
| `COPILOT_ANTHROPIC_API_KEY` | unset                    | Optional; never hardcode or commit                |

To get started, copy `.env.example` to `.env` and fill in what you need. `.env` is git-ignored.

## Run the dev server

```powershell
uvicorn main:app --reload
```

Then open http://localhost:8000/health; it should return `{"status": "ok"}`.
On startup the app creates `copilot.db` in this directory if it doesn't exist yet.
`python main.py` does the same but uses `COPILOT_HOST`/`COPILOT_PORT`.

### Exposing over Tailscale

The default bind address is `127.0.0.1`, which is reachable only from this PC.
To reach the API from the phone, bind to this PC's Tailscale IP (find it with
`tailscale ip -4`) so the API is reachable only on the tailnet:

```powershell
uvicorn main:app --host 100.x.y.z --port 8000
```

Don't bind to `0.0.0.0`: that would also expose the API on the office LAN.

## Gantt PDF parser

`gantt_parser.extract_gantt_data(pdf_path)` reads a Gantt PDF export with PyMuPDF
and asks Gemini (via litellm) to turn it into JSON with `tasks` (name, parent,
trade, start/end, percent complete), finish-to-start `dependencies` and
`milestones`. Text is sent with page coordinates so that dates can be read off
the bar positions when a chart has no date columns. Treat the output as a draft
for human review; it is not written to the database. Requires `COPILOT_GEMINI_API_KEY`.

```python
from gantt_parser import extract_gantt_data
data = extract_gantt_data("../docs/gantt/C7801 Project Plan.pdf")
print(data["tasks"][:2])
```

### Reviewing and importing a Gantt

`cli_import.py` runs the extraction, prints the JSON and a summary (project,
task/milestone/dependency counts, date range), then asks
`Approve and import to database? [Y/N]`. On `Y` it creates or updates the
`Project` and stores tasks and milestones as `Task` rows with `is_gantt_task=True`
(milestones also get `is_milestone=True`), plus their finish-to-start `Link`s.

```powershell
python cli_import.py "../docs/gantt/C7801 Project Plan.pdf"
python cli_import.py plan.pdf --code C7801   # if no project code can be found
```

Re-importing a project deletes its previous Gantt tasks (and their links) before
inserting the new ones; tasks that didn't come from the Gantt are kept.

## Tests

```powershell
pytest
```
