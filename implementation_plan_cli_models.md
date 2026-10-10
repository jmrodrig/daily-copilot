# Implementation Plan: All-CLI Agent Models (Claude 5.5 CLI + Gemini CLI, No API Models)

## Goal
1. **Update Claude CLI Models to Include Opus 5.5 and Sonnet 5.5:** Add `claude-opus-5-5` (mapped to `opus`) and `claude-sonnet-5-5` (mapped to `sonnet`) at the top of `CLAUDE_CLI_MODELS`.
2. **Route Gemini Models Through Local Gemini CLI (`@google/gemini-cli`) Instead of the API:**
   - Remove `_fetch_gemini_models` / live Gemini REST API model fetching from `list_models()`.
   - Expose `GEMINI_CLI_MODELS` (`gemini-3.1-pro-preview`, `gemini-3-pro-preview`, `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`) in `list_models()`.
   - Route all `GEMINI_CLI_MODELS` in `run_chat()` through the local `gemini` CLI (`_run_gemini_cli`), stripping `GEMINI_API_KEY` and `GOOGLE_API_KEY` from the subprocess environment and setting `GOOGLE_GENAI_USE_GCA="true"` so it always uses the user's Google OAuth login (`oauth-personal`) and never bills an API key.
3. **Update Frontend Model Picker (`desktop/src/components/CopilotChat.tsx`):**
   - Label both sections as Local CLI (No API):
     - **Claude Agent** (`Local CLI · No API`)
     - **Gemini Agent** (`Local CLI · No API`)

---

## Detailed Changes

### 1. `backend/agent.py` & `backend/config.py`

#### A. Model Definitions (`backend/agent.py`)
```python
CLAUDE_CLI_MODELS: dict[str, str] = {
    "claude-opus-5-5": "opus",
    "claude-sonnet-5-5": "sonnet",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5": "haiku",
}

GEMINI_CLI_MODELS: dict[str, str] = {
    "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-pro-preview": "gemini-3-pro-preview",
    "gemini-3.8-flash": "gemini-3.8-flash",
    "gemini-3.5-flash": "gemini-3.5-flash",
    "gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
}
```
- Update `bare_model_name(model: str) -> str` to strip `gemini/`, `claude/`, or `models/` prefixes.
- Add `is_gemini_cli_model(model: str | None) -> bool`: returns `True` if `bare_model_name(model)` is in `GEMINI_CLI_MODELS`.
- In `backend/config.py`, set default `chat_model: str = "claude-opus-5-5"`.
- In `list_models(settings)`:
  - Do NOT call `_fetch_gemini_models` or require `gemini_api_key`.
  - Return `list(dict.fromkeys([configured, *CLAUDE_CLI_MODELS, *GEMINI_CLI_MODELS]))` where `configured = bare_model_name(settings.chat_model)`.

#### B. Gemini CLI Execution (`_run_gemini_cli` in `backend/agent.py`)
- Locate binary with `shutil.which("gemini")`; if missing, raise `AgentNotConfiguredError("Gemini CLI (`gemini`) is not installed or not on PATH")`.
- Build stdin payload using the same shared helper as Claude CLI (system prompt, space notes root path, open tasks up to 200, `<write_note>` protocol for `ask_first`/`write_directly`, and conversation history).
- Build command:
  ```python
  cmd = [
      gemini_bin,
      "-p",
      "Follow the system instructions and answer the latest user message in the conversation above.",
      "-m",
      GEMINI_CLI_MODELS[bare_name],
      "-o",
      "stream-json",
      "--skip-trust",
      "--yolo",
      "--include-directories",
      str(turn.root.resolve()),
  ]
  for folder in rag_folders:
      if Path(folder).is_dir():
          cmd += ["--include-directories", folder]
  ```
- Subprocess environment (`_gemini_env()`):
  - Copy `os.environ`, remove `"GEMINI_API_KEY"` and `"GOOGLE_API_KEY"`, and set `"GOOGLE_GENAI_USE_GCA": "true"`.
- Parse `stream-json` output (`_parse_gemini_stream(stdout)`):
  - Each line in `stdout` is a JSON event from `@google/gemini-cli`:
    - `event.get("type") == "message"` and `event.get("role") == "assistant"`: append `event.get("content", "")` to the reply buffer (when `delta` is true, chunks are streamed sequentially).
    - `event.get("type") == "tool_use"`: record `tool_id = event.get("tool_id")`, `name = event.get("tool_name")`, `arguments = event.get("parameters") or {}`.
    - `event.get("type") == "tool_result"`: find matching `tool_id` and set `ok = (event.get("status") != "error")`.
    - `event.get("type") == "error"`: record error message.
    - `event.get("type") == "result"` and `event.get("status") == "error"`: raise `AgentError`.
  - If `proc.returncode != 0` or output contains `"Authentication cancelled"` / `"Opening authentication page"` / `"Please set an Auth method"`, raise `AgentNotConfiguredError("Gemini CLI needs a one-time Google sign-in: run `gemini` in a terminal and choose Login with Google.")`.
- Apply `_apply_write_blocks(reply_text, turn, summaries)` so `<write_note path="...">` blocks work identically in `ask_first`, `write_directly`, and `read_only` modes.

#### C. Routing in `run_chat()` (`backend/agent.py`)
- Determine `chosen = model.strip() if model and model.strip() else settings.chat_model`.
- If `is_claude_cli_model(chosen)` -> call `_run_claude_cli(...)`.
- If `is_gemini_cli_model(chosen)` -> call `_run_gemini_cli(...)`.
- Otherwise (e.g. `"gemini/test-model"` used by legacy LiteLLM unit tests in `test_agent.py`), run the existing LiteLLM loop so all existing unit tests in `test_agent.py` continue to pass.

### 2. Frontend Model Picker (`desktop/src/components/CopilotChat.tsx`)
- Change the second section header in the Model Picker Popover from `"Gemini API Models"` to:
  ```tsx
  <div className="flex items-center justify-between border-b border-border-default px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
    <span>Gemini Agent</span>
    <span className="font-normal normal-case tracking-normal text-project-p5002">Local CLI · No API</span>
  </div>
  ```

### 3. Tests (`backend/tests/test_agent.py` & `backend/README.md`)
- Update `list_models` tests in `backend/tests/test_agent.py` to reflect that `list_models()` returns `CLAUDE_CLI_MODELS` and `GEMINI_CLI_MODELS` without calling `_fetch_gemini_models`.
- Add unit tests for `_run_gemini_cli` (command flags, `_gemini_env` stripping `GEMINI_API_KEY` and setting `GOOGLE_GENAI_USE_GCA="true"`, `_parse_gemini_stream` handling delta messages + `tool_use` + `tool_result`, `<write_note>` handling, and `AgentNotConfiguredError` when `gemini` is missing or unauthenticated).
- Update `backend/README.md` to document both local CLI engines (`claude` and `gemini`).

---

## Verification
1. `pytest backend/tests/` — all tests must pass.
2. `npm --prefix desktop run typecheck` — must pass with 0 errors.
