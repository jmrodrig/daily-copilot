# Investigation Report: "Requested entity was not found" on `gemini-3.8-flash` in Daily Co-Pilot

**Date:** 2026-10-15
**Scope:** `backend/agent.py` Gemini CLI path, the installed `@google/gemini-cli` 0.63.0, live CLI behaviour, Gemini CLI session logs, desktop model persistence.

---

## 1. Summary

- **The installed Gemini CLI isn't the stock build.** On 2026-10-10, roughly two to five hours after `npm install`, an Antigravity agent session edited four files in the bundle. The edited CLI pretends to be Antigravity: it sends the User-Agent `antigravity/2.0.0`, uses a different OAuth client ID and secret, and talks to the **daily (pre-production) endpoint `daily-cloudcode-pa.googleapis.com`** instead of `cloudcode-pa.googleapis.com`. It also rewrites model names to internal backend aliases such as `gemini-3.8-flash-tiered` and `gemini-pro-agent`. The `getBackendModelMappings` table quoted in the brief comes from this patch, not from upstream Gemini CLI.
- **Picking `gemini-3.8-flash` never forced Gemini 3.8 Flash.** The CLI treats 3.8 Flash and the 3.x Pro models as "preview" models. This account has no preview access on that endpoint, so the CLI quietly switches to `auto-gemini-2.5` mode. A classifier then sends each prompt either to **`gemini-3.8-flash`** (simple prompts) or to **`gemini-2.5-pro`** (complex prompts).
- **The failing piece is the Pro route.** The patch maps `gemini-2.5-pro` to `gemini-pro-agent`, and that alias now returns **404 "Requested entity was not found"** on the daily endpoint. It last worked on 2026-10-12 17:00. The first 404 was on 2026-10-15 13:36 UTC. A heavy prompt like `/online-research` is classified as Pro, so it fails. "Reply OK" is classified as Flash, so it works. `gemini-3.8-flash-tiered` itself **still works today**.
- **Recommendation:** reinstall the official Gemini CLI and sign in again, rather than updating the patch with new internal aliases. Separately, harden `agent.py` and the desktop picker so a model that disappears produces a clear message or a fallback. Details in §5.

---

## 2. Evidence

### 2.1 The CLI bundle was modified after install

The installed package was compared byte for byte with a fresh `npm pack @google/gemini-cli@0.63.0`. Of 84 bundle files, 80 are identical. These four differ:

| File | Modified (local time) | Notes |
|---|---|---|
| `chunk-2V7FO5QV.js`, `chunk-IVQKNOQE.js` | 2026-10-10 19:17 | same patch as the live chunk |
| `chunk-RWBXO4OP.js` (**the chunk `gemini.js` actually loads**) | 2026-10-10 22:11 | patch plus extras below |
| `gemini-6YZTUGIX.js` | 2026-10-10 22:11 | emits `thought` events in stream-json; makes context overflow a hard error |

`package.json` and the other files date from 16:46, the original install.

Changes in the chunk files (CRLF ignored):

| Change | Upstream | Installed |
|---|---|---|
| Code Assist endpoint | `https://cloudcode-pa.googleapis.com` | `https://daily-cloudcode-pa.googleapis.com` |
| HTTP User-Agent | `GeminiCLI/0.63.0/...` | `antigravity/2.0.0` |
| OAuth client | `681255809395-…` (Gemini CLI) | `1071006060591-…` (a different client; secret also replaced) |
| `ideType` / `platform` metadata | `IDE_UNSPECIFIED` / `PLATFORM_UNSPECIFIED` | `GEMINI_CLI` / `WINDOWS_AMD64` |
| `getBackendModelMappings` | dynamic: maps `gemini-3.5-flash` to `gemini-3-flash` or `gemini-3.8-flash` depending on GA access flags | hard-coded table of internal aliases (below) |
| OAuth consent prompt (`chunk-RWBXO4OP` only) | interactive or `NO_BROWSER` consent | `return true` (consent skipped) |
| Empty-reply nudge (`chunk-RWBXO4OP` only) | system nudge text | `"Please continue."` |

The hard-coded mapping table. The brief is wrong here: the Pro models map to `gemini-pro-agent`, not to what the brief says.

```js
"gemini-3.1-pro-preview":             "gemini-pro-agent",
"gemini-3.1-pro-preview-customtools": "gemini-pro-agent",
"gemini-3-pro-preview":               "gemini-3.1-pro-low",
"gemini-3.8-flash":                   "gemini-3.8-flash-tiered",
"gemini-3.5-flash":                   "gemini-3.6-flash-high",
"gemini-3-flash-preview":             "gemini-3-flash",
"gemini-2.5-pro":                     "gemini-pro-agent"
```

`~/.gemini/oauth_creds.json` was issued to the replacement client (`aud`/`azp` = `1071006060591-…`). Tokens were not printed.

**Where the patch came from:** Antigravity session `~/.gemini/antigravity/brain/810a7898-…`. Its step outputs from about 19:10 on 2026-10-10 show the stock CLI failing with `429 RESOURCE_EXHAUSTED` on `cloudcode-pa.googleapis.com`. Its transcript chunks 70–76 then read and edit `OAUTH_CLIENT_ID` and the related code. The same session wrote this brief's earlier analysis on 2026-10-15 without noticing that the CLI it was analysing had been patched.

### 2.2 Live behaviour today (Co-Pilot's exact environment: API keys removed, `GOOGLE_GENAI_USE_GCA=true`)

**Trivial prompt ("Reply with exactly: OK"), 3 runs, same result each time:**

| Co-Pilot model (`GEMINI_CLI_MODELS`) | Result | What actually answered (`--debug` routing log) |
|---|---|---|
| `gemini-3.1-pro-preview` | OK | demoted to `auto-gemini-2.5`, classifier picked **gemini-3.8-flash** |
| `gemini-3-pro-preview` | OK | demoted to `auto-gemini-2.5`, classifier picked **gemini-3.8-flash** |
| `gemini-3.8-flash` | OK | demoted to `auto-gemini-2.5`, classifier picked **gemini-3.8-flash** |
| `gemini-3.5-flash` | OK | forced `gemini-3.5-flash`, sent as `gemini-3.6-flash-high` |
| `gemini-3.5-flash-lite` | OK | forced (no mapping) |
| `gemini-2.5-pro` | **404 Requested entity was not found** | forced, sent as `gemini-pro-agent` |
| `gemini-2.5-flash` | OK | forced (no mapping) |
| `gemini-2.5-flash-lite` | OK | forced (no mapping) |

**Research-style prompt with `-m gemini-3.8-flash`, 2 runs:**

```
[Routing] Selected model: gemini-2.5-pro (Source: agent-router/Classifier)
  Reasoning: The user is asking for online research comparing ... multi-step compliance plan ...
ModelNotFoundError: Requested entity was not found.
{"type":"result","status":"error","error":{"message":"[API Error: Requested entity was not found.]"}}
```

That is the user's error, reproduced exactly. The brief's working/failing list (3.8-flash and 3.1-pro failing) depended on what was being asked, not only on the model name.

**Why the switch to auto happens** (`chunk-RWBXO4OP.js` ~380180): `if (isPreviewModel(this.model) && this.hasAccessToPreviewModel === false) this.setModel("auto-gemini-2.5")`. `hasAccessToPreviewModel` is set from the quota endpoint: it is true only if a quota bucket names a model the CLI considers "preview". On the daily endpoint the buckets apparently carry Antigravity-internal ids, so the flag stays false. I inferred this from the code; I didn't dump the quota response. In `auto-gemini-2.5`, the Pro route resolves to `gemini-2.5-pro`, which the patch maps to `gemini-pro-agent`.

### 2.3 History from Gemini CLI session logs (`~/.gemini/tmp/content/chats`)

- Oct 10 to Oct 15 09:27: replies were recorded as `gemini-3.8-flash`, with some `gemini-2.5-pro` (Oct 10 18:27 with 19 replies, Oct 12 17:00 with 13 replies). So the `gemini-pro-agent` route **worked through at least 2026-10-12 17:00**.
- **No session in the logs was ever answered by a 3.x Pro model.** Choosing "Gemini 3.1 Pro" in Co-Pilot has always produced 3.8 Flash or 2.5 Pro.
- CLI error reports in `%TEMP%\gemini-client-error-*.json` with "Requested entity was not found": the first is **2026-10-15 13:36 UTC**, followed by about 16 more. There are none for Oct 12–14.

---

## 3. Answers to the user's questions

**"That is weird because I am using Gemini 3.8 here" / "Why does Antigravity have 3.8 while the CLI fails?"**
Gemini 3.8 Flash is still reachable from the local CLI: `gemini-3.8-flash-tiered` answers today. What fails is the separate **Pro** alias `gemini-pro-agent`. Co-Pilot reaches it because the CLI silently sends demanding prompts to "2.5 Pro", even when 3.8 Flash was selected. The brief says Antigravity uses a different internal platform. The evidence suggests otherwise: the patched CLI uses the same daily endpoint and OAuth client that Antigravity appears to use. The difference is that Antigravity is the client those internal aliases are built for, and it gets updated along with them. The CLI holds a hand-copied alias table frozen on Oct 10.

**"3.8 was running before." Why did it work on Oct 10 and fail now?**
Between 2026-10-12 17:00 and 2026-10-15 13:36 UTC, the internal alias `gemini-pro-agent` stopped resolving on the daily endpoint, most likely renamed or withdrawn. Simple turns never needed it, so they kept working. Research and analysis turns are routed to Pro and now fail.

**"Is this a temporary outage, or more permanent and affecting only me?"**
- **It affects only this machine's patched setup.** It isn't a general Gemini CLI or Gemini 3.8 outage. A stock Gemini CLI never asks for `gemini-pro-agent`.
- **For planning, treat it as permanent.** `daily-cloudcode-pa` is Google's pre-production environment and the aliases are internal to another product. They can change daily without notice. The alias might come back, but nothing external would tell us, and other aliases (`gemini-3.8-flash-tiered`, `gemini-3.6-flash-high`, `gemini-3.1-pro-low`) can break the same way at any time.

---

## 4. Risk note on the current setup

The patch makes Co-Pilot look like Antigravity to Google: borrowed OAuth client, spoofed User-Agent, an internal pre-production endpoint, and internal model ids. Besides being fragile, this very likely goes beyond what the user's Google account is authorised to do through the Gemini CLI, and could put the account at risk. It is also silently undone by any `npm install -g`/`npm update` of the CLI. **I don't recommend repairing it by finding the new internal alias names.** The fix below goes back to the supported path.

---

## 5. Recommendations

### 5.1 Restore a supported CLI (fixes the root cause)

1. Reinstall the official package: `npm install -g @google/gemini-cli@latest` (or `@0.63.0`). This overwrites the four patched files.
2. Sign in again. The cached `oauth_creds.json` belongs to the other OAuth client and won't refresh under the Gemini CLI's own client. Run `gemini` once in a terminal and choose "Login with Google". Agent.py's existing `_GEMINI_AUTH_MARKERS` check already tells the user to do this.
3. Re-run the probe in §2.2 (script in §6) and set `GEMINI_CLI_MODELS` to the models that work. The original reason for the patch was 429 quota errors on the stock endpoint. Expect the stock free tier to have lower limits and not to include every preview model. That is the supported envelope. If more capacity is needed, the options are a Gemini API key via litellm (already supported in `_litellm_turn`) or a paid Code Assist tier.

I didn't run the stock CLI here. Doing so would have meant re-authenticating, which could replace the user's current credentials. Its exact model availability for this account is therefore **not verified**.

### 5.2 Backend hardening (`backend/agent.py`), worth doing either way

**a. Never let a stale or removed name fall through to the API-key path.** Today an unknown name goes to `chat_model_id`, which turns it into `gemini/<name>` and runs it through litellm with an API key. That contradicts the "no API key" intent. Add an alias table that is checked before routing:

```python
# Gemini CLI models withdrawn from the picker -> what a saved pick of them now runs on.
RETIRED_GEMINI_CLI_MODELS: dict[str, str] = {
    "gemini-3.8-flash": "gemini-3.5-flash",
    "gemini-3.1-pro-preview": "gemini-2.5-pro",
    "gemini-3-pro-preview": "gemini-2.5-pro",
}

def bare_model_name(model: str | None) -> str:
    ...
    return RETIRED_GEMINI_CLI_MODELS.get(name, name)
```

Keep `list_models()` limited to `GEMINI_CLI_MODELS`, so retired names are no longer offered but still resolve.

**b. Retire models instead of deleting them.** Move a dead model out of `GEMINI_CLI_MODELS` and into `RETIRED_GEMINI_CLI_MODELS`. Deleting it outright makes saved picks fall through to litellm (see a). Fall back to the **closest working** model, not always `gemini-3.5-flash`: Pro picks should land on a Pro model if one is available.

**c. Recognise a missing model and retry once.** In `_check_gemini` / `_gemini_events`, detect `"Requested entity was not found"` / `ModelNotFoundError` and raise a dedicated `ModelUnavailableError(model)`. In `run_chat`/`stream_chat`, if no text or tool calls have been emitted yet, retry once with `GEMINI_CLI_FALLBACK = "gemini-2.5-flash"`, the most stable option in today's probe. Emit a notice event so the UI can say "Gemini 3.8 Flash isn't available to your Google sign-in right now. Answered with Gemini 2.5 Flash." If the fallback also fails, show that text instead of the raw `[API Error: …]`.

**d. Show which model actually answered.** The CLI's stream-json `init` event carries the effective model (`"model":"auto-gemini-2.5"` when it has silently switched to auto). Record it in `_StreamState` and return it in `ChatResponse` / a stream event. If it differs from the request, the UI can show "routed by Gemini CLI", which would have made this incident obvious.

**e. Optional availability check.** Add `GET /api/models?check=1`, which runs the §6 probe concurrently with a short timeout and caches results for about 30 minutes. The picker can then grey out unavailable models. Keep it opt-in, because each check costs a CLI start and some quota.

**f. Tests** (in `backend/tests/test_agent.py`): retired-name aliasing (`is_gemini_cli_model("gemini-3.8-flash")` still true and resolves to the fallback); a 404 stream-json result raises `ModelUnavailableError`; retry-on-404 uses the fallback and emits the notice; retry is skipped once output has started; `list_models()` excludes retired names.

Also note `config.py: gantt_model = "gemini/gemini-3.1-pro-preview"`. This goes through litellm and an API key, not the CLI, so it is unaffected. It is worth checking separately whether that preview model is still served on the API.

### 5.3 Desktop (`desktop/src/components/CopilotChat.tsx`)

1. **Check the saved pick against the server's model list.** After `/api/models` loads, if the stored `copilot_chat_model` isn't in the list, switch to the server default (from `/health`), update `localStorage`, and show a one-line notice: "Gemini 3.8 Flash is no longer available. Switched to …".
   ```ts
   getJson<string[]>("/api/models").then((list) => {
     setModels(list);
     setModel((picked) => {
       if (!picked || list.includes(picked)) return picked;
       localStorage.removeItem(MODEL_KEY);
       setNotice(`${picked} is no longer available; using ${list[0]}.`);
       return list[0] ?? null;
     });
   });
   ```
2. **Stop re-offering stale models.** Line 953 prepends the saved model to the menu even when the server doesn't list it (`model && !models.includes(model) ? [model, ...models] : models`). Drop that once item 1 is in place.
3. **Handle the new notice and actual-model events** from 5.2c/d: a subtle "answered by X" under the reply.
4. With backend aliasing (5.2a) in place, even an older desktop build with a stale `localStorage` value keeps working.

---

## 6. Reproduction / probe script

```python
import os, subprocess, shutil, json
models = ["gemini-3.1-pro-preview","gemini-3-pro-preview","gemini-3.8-flash","gemini-3.5-flash",
          "gemini-3.5-flash-lite","gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite"]
env = {k: v for k, v in os.environ.items() if k not in ("GEMINI_API_KEY", "GOOGLE_API_KEY")}
env["GOOGLE_GENAI_USE_GCA"] = "true"
for m in models:
    p = subprocess.run([shutil.which("gemini"), "-p", "Reply with exactly: OK", "-m", m, "-o", "stream-json",
                        "--skip-trust"], capture_output=True, text=True, encoding="utf-8", env=env,
                       stdin=subprocess.DEVNULL, timeout=150)
    events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    init = next((e.get("model") for e in events if e.get("type") == "init"), None)
    err = next((e.get("error") for e in events if e.get("type") == "result" and e.get("status") == "error"), None)
    print(m, "effective:", init, "rc:", p.returncode, "error:", err)
```

Add `--debug` and grep `[Routing]` to see which concrete model the classifier picked. Also test one **complex** prompt per model, because the auto router only uses the Pro route for demanding prompts.

---

## 7. Corrections to the brief

| Brief statement | Finding |
|---|---|
| `getBackendModelMappings` is how gemini-cli 0.63.0 maps models | It's a local patch. Upstream builds the mapping dynamically and never uses `-tiered`, `gemini-pro-agent`, etc. |
| `gemini-3-pro-preview` → `gemini-3.1-pro-low`, and nothing listed for 3.1-pro/2.5-pro | `gemini-3.1-pro-preview` and `gemini-2.5-pro` both map to `gemini-pro-agent`, the alias that 404s |
| `gemini-3.8-flash` and `gemini-3.1-pro-preview` fail | Both succeed on simple prompts. Both fail on complex prompts because they are silently routed to `gemini-2.5-pro` → `gemini-pro-agent` |
| CLI uses the "Code Assist preview API" while Antigravity uses a different internal platform | The patched CLI uses `daily-cloudcode-pa` with the replacement OAuth client and `antigravity/2.0.0` UA, i.e. the same setup Antigravity appears to use |
| Preview entity names "rotate" | Only true of the internal aliases the patch depends on. The public model names were never sent to the server as-is for mapped models |
