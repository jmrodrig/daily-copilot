# Implementation Plan: Fix Model Dropdown Formatting & Filter Non-Chat Models

## Branch
Continue on branch `feat/local-files`.

---

## 1. Problem Description
1. **White-on-White Text / Unstyled Native `<select>`**:
   In `desktop/src/components/CopilotChat.tsx`, the model selector was implemented using a raw `<select>` and `<option>` tags inside a dark-mode styled `<label>`. On Chromium/Windows, the native `<select>` popup displays with a bright white background, but the `<option>` elements inherit the dark mode light-gray text color (`text-inherit`), making unselected options completely invisible (white text on white background).
2. **Cluttered Model List**:
   In `backend/agent.py`, `_fetch_gemini_models` fetches all models with `generateContent`. This pulls in specialized non-chat models like text-to-speech (`-tts`), audio transcribe (`-transcribe`), image generation (`-image`), robotics (`-robotics`), computer use (`-computer-use`), and test models (`banana`), cluttering the list and causing errors if selected for general chat.

---

## 2. Changes Needed

### A. Backend: Filter to Chat Models Only (`backend/agent.py`)
1. Define non-chat model exclusions:
   ```python
   _NON_CHAT_SUBSTRINGS = (
       "-tts",
       "-transcribe",
       "-image",
       "-robotics",
       "-computer-use",
       "banana",
       "embedding",
       "aqa",
   )
   ```
2. In `_fetch_gemini_models`:
   Filter out any model name containing any substring from `_NON_CHAT_SUBSTRINGS`:
   ```python
   if (
       name.startswith("gemini")
       and "generateContent" in model.get("supportedGenerationMethods", [])
       and not any(sub in name.lower() for sub in _NON_CHAT_SUBSTRINGS)
   ):
       names.append(name)
   ```
3. This ensures only genuine conversational LLMs (e.g. `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`, `gemini-3.1-pro-preview`) are returned.

### B. Frontend: Replace Native `<select>` with `<Popover>` (`desktop/src/components/CopilotChat.tsx`)
1. Import `Popover` from `./Popover`.
2. Replace the native `<label><select>...</select></label>` with a custom trigger button + `Popover`:
   - State: `const [modelMenu, setModelMenu] = useState(false);`
   - Ref: `const modelButtonRef = useRef<HTMLButtonElement>(null);`
   - Trigger Button:
     ```tsx
     <button
       ref={modelButtonRef}
       type="button"
       aria-haspopup="listbox"
       aria-expanded={modelMenu}
       onClick={() => setModelMenu((open) => !open)}
       disabled={sending || (!model && !models.length)}
       className="btn min-h-[34px] gap-2 px-3 text-xs font-medium text-text-primary hover:bg-surface-hover"
       title="Select Gemini model"
     >
       <span className={`h-2 w-2 shrink-0 rounded-full ${model ? "bg-project-p5002" : "bg-project-neutral"}`} />
       <span className="max-w-[12rem] truncate">{model ?? "Model"}</span>
       <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
         <path d="M4 6l4 4 4-4" />
       </svg>
     </button>
     ```
   - Menu using `Popover`:
     ```tsx
     <Popover
       anchor={modelButtonRef}
       open={modelMenu}
       onClose={() => setModelMenu(false)}
       label="Select Gemini model"
       role="listbox"
       className="w-64 max-h-72 overflow-y-auto"
     >
       <div className="border-b border-border-default px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
         Gemini Models
       </div>
       <div className="py-1">
         {(model && !models.includes(model) ? [model, ...models] : models).map((name) => {
           const isSelected = name === model;
           return (
             <button
               key={name}
               type="button"
               role="option"
               aria-selected={isSelected}
               onClick={() => {
                 pickModel(name);
                 setModelMenu(false);
               }}
               className={`flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
                 isSelected
                   ? "bg-accent/20 font-medium text-accent-soft"
                   : "text-text-primary hover:bg-surface-hover"
               }`}
             >
               <span className="truncate">{name}</span>
               {isSelected && (
                 <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
                   <path d="M3.5 8.5l3 3 6-6" />
                 </svg>
               )}
             </button>
           );
         })}
       </div>
     </Popover>
     ```
3. Styling & Dark Mode:
   - `Popover` already uses `bg-surface-active border border-border-strong text-[13px] shadow-xl shadow-black/40`, perfectly matching the dark theme.
   - Options have strong contrast (`text-text-primary`, with `text-accent-soft` and background tint when selected).

---

## 3. Verification
1. Run `npm run typecheck` in `desktop/`.
2. Run backend tests: `pytest backend/tests/`.
3. Check `GET /api/models` returns only valid chat models without TTS, transcribe, or robotics.
4. Verify the popover renders with proper dark theme contrast and readable text.
