# Investigation Brief: Gemini 3.8 CLI Model Error in Daily Co-Pilot

## Context & User Report
The user reported the following error in the Co-Pilot Chat UI when submitting a query (e.g. `/online-research`):
```
Could not get an answer (The Gemini CLI failed: [API Error: Requested entity was not found.])
```
This error occurred when model `gemini-3.8-flash` was selected.

User comments and questions:
1. "that is weird because I am using gemini 3.8 here" (referring to the Antigravity assistant).
2. "Is this a temporary outage or is it something more permanent and affecting me only?"
3. "But 3.8 was running before."

## Known Facts & Prior Findings
1. **Historical Verification**:
   - In `C:\Users\designer\.gemini\tmp\content\chats\session-2026-10-10T21-35-e00c196d.jsonl` from October 10, 2026, `gemini-3.8-flash` **was** running and active in Co-Pilot, handling tool calls and large token contexts (>110k tokens).
2. **Architecture**:
   - Co-Pilot runs `gemini.CMD` (`@google/gemini-cli` installed at `C:\Users\designer\AppData\Roaming\npm\node_modules\@google\gemini-cli`).
   - `backend/agent.py` configures `_gemini_env()` with `GOOGLE_GENAI_USE_GCA = "true"` (Google Cloud Code / Code Assist consumer preview gateway) and Google OAuth credentials (`~/.gemini/oauth_creds.json`).
   - In `@google/gemini-cli` (v0.63.0), `getBackendModelMappings` maps:
     - `"gemini-3.8-flash"` -> `"gemini-3.8-flash-tiered"`
     - `"gemini-3.5-flash"` -> `"gemini-3.6-flash-high"`
     - `"gemini-3-pro-preview"` -> `"gemini-3.1-pro-low"`
3. **Current API Error (October 15, 2026)**:
   - Calling `gemini.CMD` with `-m gemini-3.8-flash` now returns:
     `ModelNotFoundError: Requested entity was not found. (code: 404)`
   - The same occurs for `gemini-3.1-pro-preview` and `gemini-2.5-pro`.
   - In contrast, `gemini-3.5-flash`, `gemini-3-pro-preview`, `gemini-3.5-flash-lite`, and `gemini-2.5-flash` succeed and produce full stream responses.
4. **Antigravity vs. Gemini CLI**:
   - Antigravity connects directly to internal developer platform endpoints where `gemini-3.8` models are active.
   - Local Gemini CLI connects via GCA to Google's Code Assist preview API, where preview entity names rotate.

## Objectives for Claude Opus 5.5
1. Conduct an independent, rigorous investigation of the Gemini CLI invocation in `backend/agent.py`, the CLI binary in npm, and current endpoint responses.
2. Confirm which Gemini CLI models in `backend/agent.py` (`GEMINI_CLI_MODELS`) are working vs failing.
3. Address the user's specific questions:
   - Why did it work on Oct 10 and fail now?
   - Is it temporary or permanent?
   - Why does Antigravity have 3.8 while Gemini CLI fails?
4. Propose an actionable, robust solution:
   - How should `backend/agent.py` / `desktop` be updated to handle model availability?
   - Should defunct preview models be removed or aliased/fallback to `gemini-3.5-flash`?
   - How to ensure users with saved preferences in `localStorage` don't get stuck on defunct models?
5. Write your complete analysis, findings, and concrete solution into:
   `C:\Users\designer\Documents\assistant\copilot\investigation_gemini_38_report.md`
