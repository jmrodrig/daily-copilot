# Implementation Plan: Restore Official Gemini CLI & Preserve Chat Behavior / Thinking Feedback

## 1. Objectives
1. **Restore the official `@google/gemini-cli`**:
   - Install the latest official `@google/gemini-cli` (v0.64.0) via `npm install -g @google/gemini-cli@latest`.
   - Remove the previous spoofed OAuth client ID, `antigravity/2.0.0` User-Agent, and daily pre-production endpoint (`daily-cloudcode-pa.googleapis.com`) $\rightarrow$ restore official Google Cloud Code endpoint (`cloudcode-pa.googleapis.com`) and official OAuth client (`681255809395-...`).
2. **Preserve exact chat behavior, formatting, and live "thinking" feedback**:
   - Stock `@google/gemini-cli` drops `GeminiEventType.Thought` in non-interactive `stream-json` mode (`runNonInteractive2` and `runNonInteractive`).
   - Create an automated, repeatable script `scripts/patch_gemini_cli_stream.py` that instruments `runNonInteractive2` and `runNonInteractive` in the installed CLI bundle to emit `type: "thought"` events to `streamFormatter`.
   - This keeps the CLI 100% official for networking, OAuth, and model routing, while preserving the live thinking accordion and markdown rendering in `CopilotChat.tsx`.
3. **Application Hardening**:
   - In `backend/agent.py`:
     - Add `RETIRED_GEMINI_CLI_MODELS` to alias withdrawn preview models (`gemini-3.8-flash` $\rightarrow$ `gemini-3.5-flash`, `gemini-3.1-pro-preview` $\rightarrow$ `gemini-2.5-pro`) so existing user settings never crash or fall through to litellm.
     - Update `GEMINI_CLI_MODELS` to list official working models (`gemini-3.5-flash`, `gemini-3-pro-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`).
     - Detect 404 `ModelNotFoundError` / `Requested entity was not found` before output starts and automatically retry once on stable fallback `gemini-2.5-flash` with a user-facing notice.
   - In `desktop/src/components/CopilotChat.tsx`:
     - Validate saved model against `/api/models`; reset to server default if no longer offered.
     - Remove logic that re-prepends unknown saved models into the dropdown.
4. **Authentication Gate**:
   - Cleanly back up stale `~/.gemini/oauth_creds.json`.
   - Instruct the user to run `gemini` in a terminal to complete the official Google login.

---

## 2. Detailed Technical Design & Implementation Steps

### Step 1: Install Official `@google/gemini-cli@latest`
Run:
```powershell
npm install -g @google/gemini-cli@latest
```
Verify the installation:
- Path: `C:\Users\designer\AppData\Roaming\npm\node_modules\@google\gemini-cli`
- Version: 0.64.0+
- All files in `bundle/` match upstream stock build (no `daily-cloudcode-pa`, no spoofed client ID).

### Step 2: Automated Thinking Stream Instrumentation (`scripts/patch_gemini_cli_stream.py`)
Create `scripts/patch_gemini_cli_stream.py` to ensure idempotence. The script:
1. Locates the installed `@google/gemini-cli/bundle` directory.
2. Finds the active entry bundles containing `runNonInteractive2` and `runNonInteractive` (e.g. `gemini-Q2GRYIAK.js`, `gemini-6ESINPDZ.js`, `gemini-IPXWMEB5.js`).
3. In `runNonInteractive2`, locates the responseStream event loop:
   ```javascript
   for await (const event of responseStream) {
     if (abortController.signal.aborted) {
       handleCancellationError(config);
     }
   ```
   and injects:
   ```javascript
     if (event.type === GeminiEventType.Thought && streamFormatter) {
       streamFormatter.emitEvent({
         type: "thought",
         timestamp: (new Date()).toISOString(),
         subject: event.value?.subject,
         description: event.value?.description
       });
     }
   ```
   and in context overflow handling:
   ```javascript
     else if (event.type === GeminiEventType.ContextWindowWillOverflow) {
       const message = `Context window will overflow (estimated: ${event.value.estimatedRequestTokenCount} tokens, remaining: ${event.value.remainingTokenCount} tokens)`;
       if (streamFormatter) {
         streamFormatter.emitEvent({
           type: JsonStreamEventType.ERROR,
           timestamp: (new Date()).toISOString(),
           severity: "error",
           message
         });
       }
       throw new Error(message);
     }
   ```
4. In `runNonInteractive` (ADK session mode), inside `for (const part of event.content)`:
   Injects:
   ```javascript
   else if (part.type === "thought" && streamFormatter) {
     streamFormatter.emitEvent({
       type: "thought",
       timestamp: (new Date()).toISOString(),
       subject: part.subject,
       description: part.thought
     });
   }
   ```
5. Verifies syntax via `node --check` and logs confirmation.

### Step 3: Backend Hardening (`backend/agent.py`)
1. **Define Retired Models Table**:
   ```python
   RETIRED_GEMINI_CLI_MODELS: dict[str, str] = {
       "gemini-3.8-flash": "gemini-3.5-flash",
       "gemini-3.1-pro-preview": "gemini-2.5-pro",
   }
   ```
2. **Update `GEMINI_CLI_MODELS`**:
   ```python
   GEMINI_CLI_MODELS: dict[str, str] = {
       "gemini-3.5-flash": "gemini-3.5-flash",
       "gemini-3-pro-preview": "gemini-3-pro-preview",
       "gemini-2.5-pro": "gemini-2.5-pro",
       "gemini-2.5-flash": "gemini-2.5-flash",
       "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
   }
   ```
3. **Resolve Retired Models**:
   In `bare_model_name`:
   ```python
   def bare_model_name(model: str | None) -> str:
       if not model:
           return ""
       name = model.strip().split("/")[-1]
       return RETIRED_GEMINI_CLI_MODELS.get(name, name)
   ```
   In `is_gemini_cli_model`:
   Recognize both active and retired Gemini CLI model names so retired models stay on the CLI path.
4. **Fallback on 404 / Unavailable Model**:
   Define `GEMINI_CLI_FALLBACK = "gemini-2.5-flash"`.
   In `_run_gemini_cli` and `stream_chat`, detect `ModelNotFoundError` or `Requested entity was not found`. If detected before any reply text or tool calls have been yielded, retry once with `GEMINI_CLI_FALLBACK` and yield a notice:
   `{"type": "notice", "text": f"Model '{model}' is currently unavailable; answered with {GEMINI_CLI_FALLBACK}."}`.

### Step 4: Frontend Hardening (`desktop/src/components/CopilotChat.tsx`)
1. **Validate Saved Pick**:
   In `getJson<string[]>("/api/models")`:
   ```typescript
   getJson<string[]>("/api/models").then((list) => {
     setModels(list);
     setModel((picked) => {
       if (!picked || list.includes(picked)) return picked;
       localStorage.removeItem(MODEL_KEY);
       return list[0] ?? null;
     });
   });
   ```
2. **Clean Dropdown Options**:
   Remove `(model && !models.includes(model) ? [model, ...models] : models)` on line 953 and use `models.filter(group.matches)`.

### Step 5: Tests & Verification
1. Run `pytest backend/tests/test_agent.py` to verify:
   - CLI model detection and retired model alias resolution.
   - Stream event parsing of thought, message, and tool calls.
   - 404 fallback mechanism.
2. Run `npm run build` in `desktop/` to verify TypeScript compilation and bundle validity.
3. Prepare user instructions for Google OAuth sign-in (`gemini` command).

---

## 3. Deployment Plan for Claude Opus 5.5 Implementer
Deploy Claude Opus 5.5 via CLI:
```powershell
claude -p "Execute the implementation plan at C:\Users\designer\Documents\assistant\copilot\implementation_plan_restore_official_gemini_cli.md. Follow all instructions carefully, ensuring type safety, build verification, and automated tests. Do not commit or merge to main." --model opus --add-dir C:\Users\designer\Documents\assistant\copilot --dangerously-skip-permissions
```
After the implementer reports completion, prompt the user to perform the one-time authentication.
