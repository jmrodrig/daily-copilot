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
| `COPILOT_GEMINI_API_KEY`    | unset                    | Optional; never hardcode or commit                |
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

## Tests

```powershell
pytest
```
