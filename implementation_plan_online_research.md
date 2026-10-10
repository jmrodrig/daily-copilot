# Implementation Plan: Online Research Command, Web Search Tools & Local Agent CLI Engine (No API Key)

## Goal
1. **Seed `/online-research` Slash Command:** Add a default slash command `/online-research` for conducting deep, structured online naval architecture and marine engineering research.
2. **Add Live Web Search & Page Fetching Tools (`search_web`, `fetch_web_page`) to `backend/agent.py`:** Enable Gemini API models to search the live web and read web pages during tool-calling rounds.
3. **Add Local Agent CLI Engine (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`) to `backend/agent.py` and `CopilotChat.tsx`:** Allow the Co-pilot chat to run on the local `claude` CLI (`@anthropic-ai/claude-code`), which uses the user's logged-in subscription (`apiKeySource: none`) without consuming any paid API keys, providing the same agentic experience (live `WebSearch`, `WebFetch`, local file `Read`/`Glob`/`Grep`, and note editing) as the workspace.

---

## 1. Seed `/online-research` Command (`backend/main.py` & `backend/README.md`)
- In `backend/main.py`, add `/online-research` to `DEFAULT_PROMPTS`:
  ```python
  schemas.SavedPromptIn(
      command="/online-research",
      description="Conduct thorough online technical research on marine & naval architecture topics",
      instruction=(
          "Conduct a thorough, multi-perspective online technical investigation into the following topic using your "
          "web search and page fetching tools (as well as local notes and files if relevant). Synthesize your "
          "findings into a rigorous engineering brief structured into: "
          "1) Executive Summary & Core Engineering Principles, "
          "2) Regulatory & Compliance Context (ISO Small Craft standards, RCD/CE, classification rules), "
          "3) Industry State-of-the-Art & Best Practices, "
          "4) Engineering Trade-offs & Sensitivity Analysis (weight, CoG, hydrodynamics, cost, manufacturability), and "
          "5) Actionable Recommendations with cited sources and URLs. Topic to investigate: "
      ),
  ),
  ```
- Because `seed_prompts` checks `if prompt.command not in had`, existing spaces will automatically receive `/online-research` the next time prompts are loaded.
- Update `DEFAULT_COMMANDS` in `backend/tests/test_api.py` to `["/design-search", "/online-research", "/prep", "/rcd"]` (note: `GET /api/prompts` orders alphabetically by `command`).

---

## 2. Web Search & Page Fetching Tools in `backend/agent.py`
Add two new tools to `TOOLS` and `_Turn.call` in `backend/agent.py` so Gemini models (and any LiteLLM model) can research online:

### A. `search_web(query: str) -> dict[str, Any]`
- Sends an HTTP request to DuckDuckGo HTML (`https://html.duckduckgo.com/html/?q=...`) with a standard browser `User-Agent` header and a 10-second timeout.
- Parses result titles, URLs (unwrapping DuckDuckGo's `uddg=` redirect parameter if present), and snippets using `html.parser` or regex, returning up to `SEARCH_LIMIT` (10) results:
  `{"query": query, "results": [{"title": ..., "url": ..., "snippet": ...}, ...]}`.
- Raises `ToolError` on network/HTTP failure so the agent can recover cleanly.

### B. `fetch_web_page(url: str) -> dict[str, Any]`
- Validates that `url` uses `http://` or `https://` (reject `file://` or other schemes with `ToolError`).
- Fetches the URL with `urllib.request.urlopen` (timeout 10s, standard `User-Agent`).
- Extracts readable text (removing `<script>`, `<style>`, `<noscript>` blocks and stripping HTML tags, collapsing whitespace) and truncates to `READ_LIMIT` (20,000 characters).
- Returns `{"url": url, "title": title, "content": text}`.

### C. Update `SYSTEM_PROMPT` in `backend/agent.py`
- Mention in `Rules:` that the agent can search the live internet with `search_web` and read web pages with `fetch_web_page` for online technical research, standards, vendor data, and publications, and should cite URLs it relied on.

---

## 3. Local Agent CLI Engine (`claude-*`) in `backend/agent.py` & `backend/schemas.py`

### A. Model Constants & Listing (`backend/agent.py`)
- Define:
  ```python
  CLAUDE_CLI_MODELS: dict[str, str] = {
      "claude-opus-4-6": "opus",
      "claude-sonnet-4-6": "sonnet",
      "claude-haiku-4-5": "haiku",
  }
  ```
- Helper `is_claude_cli_model(model: str | None) -> bool`:
  Returns `True` if `model` (stripped of optional `claude/` or `models/` prefix) is in `CLAUDE_CLI_MODELS`.
- In `list_models(settings)`:
  Include `list(CLAUDE_CLI_MODELS)` alongside the Gemini models:
  `return list(dict.fromkeys([configured, *CLAUDE_CLI_MODELS, *(names or FALLBACK_MODELS)]))`
- In `backend/schemas.py`:
  Keep `ChatRequest.model` pattern `r"^(gemini/|models/|claude/)?[A-Za-z0-9._-]+$"` so `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` are valid while `openai/gpt-4o`, `gemini 2.5`, `../x` are still rejected with 422.

### B. Executing a Chat Turn via Claude CLI (`_run_claude_cli` in `backend/agent.py`)
When the chosen model (either `model` parameter or `settings.chat_model`) is a Claude CLI model:
1. **No API Key Required:** Do NOT raise `AgentNotConfiguredError("COPILOT_GEMINI_API_KEY is not set")` when running a Claude CLI model! Instead, locate the binary via `shutil.which("claude")`; if not found, raise `AgentNotConfiguredError("Claude CLI (`claude`) is not installed or not on PATH")`.
2. **System & Context Prompt Construction (Passed via `stdin`, NOT command-line args):**
   - **CRITICAL WINDOWS NOTE:** On Windows, `claude` is a `.CMD` wrapper executed by `cmd.exe`, which has an 8,191-character command-line limit and breaks on multi-line arguments. Therefore, pass the entire system prompt + space context + conversation history via `stdin` (`input=full_prompt` in `subprocess.run`), NOT via `--system-prompt` on the command line!
   - Include in the prompt sent via `stdin`:
     - System instructions (`SYSTEM_PROMPT` with `today`, `space_name`, `write_rules`, `context`).
     - The absolute path to the space's notes directory (`turn.root.resolve()`) so Claude can use `Read`, `Glob`, and `Grep` directly on the space's markdown notes.
     - A summary of the space's open tasks from `list_tasks(space_id=space_id)` so Claude can answer task/schedule questions accurately.
     - Note-writing protocol when `mode != AccessMode.READ_ONLY`:
       Instruct Claude:
       *"Do NOT use Write or Edit tools on files directly. To create or update a note in this space, include a `<write_note path=\"relative/path.md\">` block containing the full markdown content (with optional YAML front-matter) in your response, e.g.:\n`<write_note path=\"C7801/Report.md\">\n---\ntype: report\n---\n# Heading\n...\n</write_note>`\nThe Co-pilot app will automatically process this block according to the active access mode (proposing a diff card for user approval in ASK FIRST mode, or saving it in WRITE DIRECTLY mode)."*
     - The conversation history (`messages`) ending with the latest user message.
3. **Command-Line Invocation:**
   ```python
   cmd = [
       claude_bin,
       "-p",
       "--model", CLAUDE_CLI_MODELS[bare_name],
       "--output-format", "stream-json",
       "--verbose",
       "--no-session-persistence",
       "--dangerously-skip-permissions",
       "--tools", "Read,Glob,Grep,WebSearch,WebFetch",
       "--add-dir", str(turn.root.resolve()),
   ]
   ```
   - Also append `--add-dir <folder>` for each existing folder in the space's `rag_folders`.
   - If `reasoning_effort` in `("low", "medium", "high")`, append `["--effort", reasoning_effort]`.
4. **Parsing `stream-json` Output & `<write_note>` Blocks:**
   - Parse each JSON line from `stdout`:
     - When `type == "assistant"`, inspect `message.content` items: for any item with `type == "tool_use"`, record its `id`, `name`, and `input` dict.
     - When `type == "user"`, inspect `message.content` items: for any item with `type == "tool_result"`, match `tool_use_id` and mark `ok = not item.get("is_error", False)`.
     - When `type == "result"`, extract `result` string (and check `is_error`).
   - Parse any `<write_note path="...">...</write_note>` blocks in the reply text:
     - If the block starts with YAML front-matter (`---\n...\n---\n`), parse it with `yaml.safe_load` and pass `(path, body, frontmatter)` to `turn.write_note(path, body, frontmatter)` (when `mode != AccessMode.READ_ONLY`).
     - Record a `ToolCallSummary(name="write_note", arguments={"path": path}, ok=True)` (or `False` on `ToolError`).
     - Strip the raw `<write_note ...>...</write_note>` block from the displayed `reply` (keeping any surrounding explanation, or providing a clean default summary if the reply was only the block).
   - Return `ChatResponse(reply=..., proposed_edits=list(turn.proposed.values()), written_paths=turn.written, tool_calls=summaries)`.

---

## 4. Frontend Model Selector Grouping (`desktop/src/components/CopilotChat.tsx`)
- Update the Model Picker Popover in `CopilotChat.tsx` so it clearly groups:
  - **Claude Agent (Local CLI · No API)** — for models starting with `claude-` (with a subtle badge or subtitle like `Local CLI`).
  - **Gemini API Models** — for `gemini-*` models.
- Update button tooltip/labels from `"Select Gemini model"` to `"Select model"`.

---

## 5. Verification
1. Run `pytest backend/tests/` — all existing and new tests (covering `/online-research` seeding, `search_web`, `fetch_web_page`, and Claude CLI model routing + `<write_note>` parsing) must pass.
2. Run `npm --prefix desktop run typecheck` — must pass with 0 errors.
