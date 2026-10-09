# Implementation Plan: Fix Agent Search Bottleneck & Empty Final Answer

## Branch
Continue on branch `feat/local-files`.

---

## 1. Problem Summary
1. **Empty Final Answer (`(The model returned no answer.)`)**:
   In `backend/agent.py`, when `round_ == MAX_TOOL_ROUNDS`, the loop set `last = True` and passed `tools` with `tool_choice="none"`. Gemini ignores `tool_choice="none"` when function declarations are in the request payload and continues returning tool calls with `content: None`. Because `last` is True, `run_chat` aborted and fell back to `message.content or "(The model returned no answer.)"`.
2. **Missing Recursive Search Tool**:
   The agent only had `list_local_directory` (listing one folder level at a time). When asked to find documents matching a query (e.g. "scantlings"), it was forced to traverse directory by directory, burning all tool rounds before finishing.
3. **Tool Round Limit**:
   `MAX_TOOL_ROUNDS = 8` was too low for deep design data research across multiple folders.

---

## 2. Implementation Steps

### A. Add Recursive Local File Search (`backend/local_files.py`)
1. Implement `search_local_files(path: str, query: str) -> dict[str, Any]`:
   - Validates `path` using `_existing(path)`.
   - Recursively traverses `path` to find files and directories whose names match `query` (case-insensitive substring match or glob).
   - Safeguards:
     - Scan limit: stops scanning after examining 10,000 files/folders to prevent freezing on infinite loops or massive drives.
     - Match limit: returns up to 100 matching entries.
     - Skips hidden files (`.git`, `__pycache__`, `$RECYCLE.BIN`, etc.).
   - Returns:
     ```python
     {
         "path": str(folder),
         "query": query,
         "count": len(matches),
         "matches": [
             {"name": f.name, "path": str(f), "type": "file" if f.is_file() else "directory", "size": f.stat().st_size if f.is_file() else 0}
             for f in matches
         ],
         "truncated": bool,
     }
     ```

### B. Register Search Tool in Agent (`backend/agent.py`)
1. In `_tool_specs(mode)`:
   - Add tool spec for `search_local_files`:
     ```json
     {
       "type": "function",
       "function": {
         "name": "search_local_files",
         "description": "Recursively search a local directory tree for files and subfolders matching a name or keyword (e.g. 'scantling', '*.xlsx', 'lines plan'). Much faster than browsing folder-by-folder with list_local_directory.",
         "parameters": {
           "type": "object",
           "properties": {
             "path": {"type": "string", "description": "The root folder to search in, e.g. 'O:\\Lawrences Files' or 'Y:\\'"},
             "query": {"type": "string", "description": "Keyword or pattern to search for in filenames"}
           },
           "required": ["path", "query"]
         }
       }
     }
     ```
2. In `_Turn.call`:
   - Map `"search_local_files": local_files.search_local_files`.
3. In `SYSTEM_PROMPT`:
   - Mention `search_local_files` alongside `list_local_directory` and `read_local_file`.
4. Update `DEFAULT_PROMPTS` for `/design-search`:
   - Instruction: `"Search the space's configured local folders using search_local_files, list_local_directory and read_local_file to answer the following: "`
5. Increase `MAX_TOOL_ROUNDS`:
   - Set `MAX_TOOL_ROUNDS = 16`.

### C. Guarantee Final Answer Generation (`backend/agent.py`)
1. In `run_chat`:
   - When `round_ == MAX_TOOL_ROUNDS` (or whenever forcing a final answer):
     - **Do NOT pass `tools` or `tool_choice` in `kwargs`!** Omit both `tools` and `tool_choice` entirely.
     - Append a final prompt to `history`:
       ```python
       history.append({
           "role": "user",
           "content": "You have reached the tool call limit. Based on all the files, notes, and data you have gathered so far, synthesize and provide your complete, detailed final answer now."
       })
       ```
     - Call `litellm.completion(**kwargs)` without tools.
     - With no tools in the payload, Gemini is guaranteed to output text (`message.content`).
   - If for any reason `message.content` is still None/empty:
     - Check `getattr(message, "reasoning_content", None)`.
     - If still empty, provide a fallback summary stating what tools were executed rather than returning `"(The model returned no answer.)"`.

---

## 3. Verification & Testing
1. Run backend tests: `pytest backend/tests/test_local_files.py` and `pytest backend/tests/test_agent.py`.
2. Test `search_local_files("O:\\Lawrences Files", "scantling")` returns results cleanly.
3. Test that hitting `MAX_TOOL_ROUNDS` produces a synthesized text answer instead of `(The model returned no answer.)`.
4. Run frontend typecheck: `npm run typecheck`.
