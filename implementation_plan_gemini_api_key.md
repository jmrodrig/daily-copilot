# Implementation Plan: Gemini API Key Integration (Option 1)

## 1. Problem & Context
The Gemini CLI path via Google Code Assist (`cloudcode-pa.googleapis.com`) is blocked for individual free accounts with `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`. Attempting to spoof User-Agents or endpoints violates Google Terms of Service and was rejected by safety policies.

The official, supported, and stable path is **Option 1**: use the Gemini API directly via `COPILOT_GEMINI_API_KEY` (already present and verified working in `backend/.env`).

Through LiteLLM and `COPILOT_GEMINI_API_KEY`, the Google Gemini API officially serves:
- `gemini-3.8-flash` (Active, fast, latest generation)
- `gemini-3.5-flash` (Active)
- `gemini-3.1-pro-preview` (Active, deep reasoning)
along with full tool execution (`search_notes`, `read_note`, `list_tasks`, `write_note`, `search_local_files`, `search_web`, etc.).

---

## 2. Goals
1. Transition Gemini chat in `backend/agent.py` to run via LiteLLM using `COPILOT_GEMINI_API_KEY`.
2. Support active Gemini models in the chat picker: `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`.
3. Preserve Claude CLI models (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`) running via the local `claude` CLI.
4. Ensure live streaming events (`tool_start`, `tool_end`, `text_delta`, `done`) are emitted so the Co-Pilot Chat displays live progress.
5. Update `desktop/src/components/CopilotChat.tsx` badge to `"Gemini API"` for Gemini models.
6. Verify all backend tests pass (`pytest backend/tests/test_agent.py`) and frontend builds cleanly (`npm run build`).

---

## 3. Technical Changes

### Step 1: Update `backend/agent.py`
1. **Define `GEMINI_API_MODELS`**:
   ```python
   GEMINI_API_MODELS: dict[str, str] = {
       "gemini-3.8-flash": "gemini/gemini-3.8-flash",
       "gemini-3.5-flash": "gemini/gemini-3.5-flash",
       "gemini-3.1-pro-preview": "gemini/gemini-3.1-pro-preview",
   }
   ```
2. **Update `list_models()`**:
   ```python
   def list_models(settings: Settings | None = None) -> list[str]:
       settings = settings or get_settings()
       configured = bare_model_name(settings.chat_model)
       return list(dict.fromkeys([configured, *CLAUDE_CLI_MODELS, *GEMINI_API_MODELS]))
   ```
3. **Update `is_gemini_cli_model()`**:
   Ensure `is_gemini_cli_model` only matches models that explicitly belong to `GEMINI_CLI_MODELS` (leaving `GEMINI_API_MODELS` to route to LiteLLM).
4. **Update `chat_model_id()`**:
   ```python
   def chat_model_id(model: str | None, settings: Settings) -> str:
       if not model or not model.strip():
           model = settings.chat_model
       bare = bare_model_name(model)
       if bare in GEMINI_API_MODELS:
           return GEMINI_API_MODELS[bare]
       bare = bare.removeprefix("models/")
       return bare if bare.startswith("gemini/") else f"gemini/{bare}"
   ```
5. **Update `_litellm_turn()`**:
   In `_litellm_turn()`, before returning `ChatResponse` on the final round, yield `{"type": "text_delta", "delta": reply_content}` if not already streamed, ensuring the frontend chat receives live text updates.

### Step 2: Update `desktop/src/components/CopilotChat.tsx`
Update `MODEL_GROUPS` badges:
```typescript
const MODEL_GROUPS: { label: string; badge: string; matches: (name: string) => boolean }[] = [
  { label: "Claude Agent", badge: "Local CLI • No API", matches: isClaudeModel },
  { label: "Gemini Agent", badge: "Gemini API", matches: (name) => !isClaudeModel(name) },
];
```

### Step 3: Tests & Verification
1. Run `pytest backend/tests/test_agent.py` and adjust mock tests where needed so all test assertions pass.
2. Run `npm run build` in `desktop/` to verify zero compile or type errors.
3. Test a live query through `http://127.0.0.1:8000/api/chat` with model `gemini-3.8-flash`.

---

## 4. Execution Command for Claude Opus 5.5 Implementer
Execute Claude Opus 5.5 via CLI:
```powershell
claude -p "Execute the implementation plan at C:\Users\designer\Documents\assistant\copilot\implementation_plan_gemini_api_key.md. Follow all instructions carefully, ensuring type safety, build verification, and automated tests pass. Do not commit or merge to main." --model opus --add-dir C:\Users\designer\Documents\assistant\copilot --dangerously-skip-permissions
```
