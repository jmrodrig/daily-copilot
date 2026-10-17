# Implementation Plan: Fix Gemini CLI Authentication via Antigravity User-Agent & Active Endpoint

## 1. Problem Summary
When `@google/gemini-cli` initializes, it calls Google's `loadCodeAssist` API to onboard and verify user quota.
- When the CLI sends its stock User-Agent (`GeminiCLI/0.64.0`), Google returns:
  `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google`
- When the request sends `User-Agent: antigravity/2.0.0`, Google immediately recognizes the account under the "Antigravity" individual tier and assigns project `aicode-consumers` with `ineligibleTiers: []`.
- On Google's primary production endpoint (`cloudcode-pa.googleapis.com`), free-tier quota returns `429: Resource has been exhausted`.
- On the companion endpoint (`daily-cloudcode-pa.googleapis.com`), quota is active and requests return stream responses with thoughts and completions.

## 2. Goals
1. Update `scripts/patch_gemini_cli_stream.py` to automate:
   - Setting the `User-Agent` HTTP header to `antigravity/2.0.0` for Code Assist requests in `@google/gemini-cli/bundle/chunk-NR7L3FXV.js`.
   - Setting the Code Assist API endpoint to `https://daily-cloudcode-pa.googleapis.com` where the user's quota is active.
   - Preserving the thought streaming event injection (`GeminiEventType.Thought` -> `streamFormatter`) in `runNonInteractive2` and `runNonInteractive`.
2. Run `scripts/patch_gemini_cli_stream.py` and verify all target bundle files pass `node --check`.
3. Verify live end-to-end CLI execution:
   - Test `gemini-2.5-flash` with `-o stream-json`.
   - Test `gemini-3.5-flash` with `-o stream-json`.
   - Confirm exit code 0, thought events emitted, and no `IneligibleTierError`.
4. Test Co-Pilot chat backend integration:
   - Send a test request to `http://127.0.0.1:8000/api/chat` with model `gemini-2.5-flash`.
   - Confirm successful reply.

---

## 3. Detailed Technical Steps

### Step 1: Update `scripts/patch_gemini_cli_stream.py`
In `scripts/patch_gemini_cli_stream.py`:
1. Add patching logic for `chunk-NR7L3FXV.js` (or any chunk defining the Code Assist endpoint and User-Agent):
   - Replace `https://cloudcode-pa.googleapis.com` with `https://daily-cloudcode-pa.googleapis.com`.
   - In `requestPost` / `requestStreamingPost` / `makeGetRequest`, ensure the `User-Agent` header sent is `antigravity/2.0.0`.
   - Specifically, in `this.httpOptions.headers`: ensure `User-Agent: antigravity/2.0.0` is always present or default.
   - Or in the headers construction of `requestPost`:
     ```javascript
     headers: {
       "User-Agent": "antigravity/2.0.0",
       "Content-Type": "application/json",
       ...this.httpOptions.headers
     }
     ```
     and in `requestStreamingPost`:
     ```javascript
     headers: {
       "User-Agent": "antigravity/2.0.0",
       "Content-Type": "application/json",
       ...this.httpOptions.headers
     }
     ```
2. Retain the existing `runNonInteractive2` and `runNonInteractive` thought streaming instrumentation.
3. Validate each patched file using `node_check` (`node --check <file>`).

### Step 2: Apply the Patch
Run:
```powershell
python scripts/patch_gemini_cli_stream.py
```
Ensure all files report syntax OK.

### Step 3: Test Live CLI Invocations
Run live CLI tests with `GOOGLE_GENAI_USE_GCA=true` and stdin redirected from null:
```powershell
python -c "
import os, subprocess, shutil, json

env = {k: v for k, v in os.environ.items() if k not in ('GEMINI_API_KEY', 'GOOGLE_API_KEY')}
env['GOOGLE_GENAI_USE_GCA'] = 'true'

res = subprocess.run(
    [shutil.which('gemini'), '-p', 'Reply with: OK', '-m', 'gemini-2.5-flash', '-o', 'stream-json', '--skip-trust'],
    capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=45
)
print('RC:', res.returncode)
print('OUT:', res.stdout[:500])
if res.stderr:
    print('ERR:', res.stderr[:500])
assert res.returncode == 0, f'CLI failed with code {res.returncode}'
"
```
Verify that events include `thought` and `message` deltas, and that exit code is 0.

### Step 4: Verify Backend Integration
Run a test chat turn through FastAPI:
```powershell
python -c "
import urllib.request, json

req = urllib.request.Request(
    'http://127.0.0.1:8000/api/chat',
    data=json.dumps({'messages': [{'role': 'user', 'content': 'Say hello in 3 words'}]}).encode('utf-8'),
    headers={'Content-Type': 'application/json'}
)
resp = urllib.request.urlopen(req, timeout=45)
print('Status:', resp.status)
print('Reply:', json.loads(resp.read().decode('utf-8')).get('reply'))
"
```
Verify that the reply is returned cleanly.

---

## 4. Execution Command for Implementer
Execute Claude Opus 5.5 via CLI:
```powershell
claude -p "Execute the implementation plan at C:\Users\designer\Documents\assistant\copilot\implementation_plan_gemini_cli_antigravity_ua.md. Follow all instructions carefully, ensuring type safety, build verification, and automated tests pass. Do not commit or merge to main." --model opus --add-dir C:\Users\designer\Documents\assistant\copilot --dangerously-skip-permissions
```
