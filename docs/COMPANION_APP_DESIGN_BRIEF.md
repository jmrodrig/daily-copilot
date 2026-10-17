# Daily Co-Pilot — Companion App Design Brief & UI Specification

**Version:** 2.0  
**Target:** Claude / Claude Design / UI Implementation Team  
**Platform:** Mobile Companion App (Android reference viewport: 390 × 844 pt, native Kotlin + Jetpack Compose or standalone mobile UI)  
**Theme:** Dark-mode by default (`#0C1216` ground), tailored for a naval architect working across design and production  

---

## 1. Executive Summary & Purpose

The **Daily Co-Pilot** is a local-first engineering assistant running on a naval architect's primary workstation, reachable 24/7 over a private Tailscale network. The companion app gives the user full mobile access to their engineering knowledge base, task management workflows, and AI co-pilot on the move (yard visits, meetings, travel, hallway handoffs).

### Key Architectural Evolution Since Inception
The initial companion app mockup was limited to a simple 3-tab "Capture / Morning List / Evening Check-in" loop. Since then, the backend and desktop system have evolved into a rich **Space-scoped Confluence/Jira hybrid**:
- **Spaces:** All content belongs to a `Space` boundary with its own folder tree, note templates, tasks, saved views, custom field schemas, status flows, and AI prompts.
- **Structured Knowledge Base:** Confluence-style folder trees, markdown notes with YAML front-matter, rich reference pills (`ref:task`, `ref:note`, `ref:url`), `#tag` pills, and uploaded assets.
- **Task Management Engine:** Database-backed tasks with custom statuses, custom fields (dropdowns, dates, numbers, checkboxes), and **Saved Task Views** (`/api/views`) supporting synced List and Kanban configurations.
- **AI Co-Pilot:** Streaming agent (`POST /api/chat/stream`) with slash commands (`/api/prompts`), tool call visibility, and human-in-the-loop edit approval (`ask_first` mode).

This brief defines the screens, user flows, architecture, styling, and exact boundary requirements for designing the mobile UI.

---

## 2. Style Guide & Design Tokens

The companion app must strictly adhere to the project's established dark-mode brand tokens defined in `shared/design-tokens.json` and `docs/brand/README.md`.

### 2.1 Color Palette

| Token Role | Hex Code | Usage & Placement |
| :--- | :--- | :--- |
| **Background / Canvas** | `#0C1216` | Main window and phone canvas background. Deep, cool dark ink. |
| **Surface Raised** | `#131B21` | Cards, task rows, list items, search inputs, modal dialogs. |
| **Surface Panel** | `#0F171C` | Top bar, bottom navigation bar, Kanban column containers, toolbars. |
| **Surface Active** | `#1A252D` | Selected tabs, active pills, user chat bubbles, hover/pressed state. |
| **Border Default** | `#25323B` | Standard 1px divider, card border, header/nav boundaries. |
| **Border Light** | `#2F3E48` | Input outlines, subtle separators, inactive chips. |
| **Border Strong** | `#34434D` | Selected card outlines, focused inputs, strong dividers. |
| **Accent Primary (Brass)** | `#F2B544` | Primary buttons, active tab indicators, milestone highlights, checkmarks. |
| **Accent Soft (Brass Light)** | `#F6C96A` | Selected pill text, secondary warnings, accent highlights. |
| **Text Primary** | `#E8EEF1` | High-contrast headings, task titles, active labels (pure off-white). |
| **Text Secondary** | `#C5D0D6` | Body text, rendered markdown, secondary labels. |
| **Text Muted** | `#97A5AE` | Subtitles, timestamps, inactive icons, breadcrumbs, placeholder text. |
| **On-Accent Text** | `#10161A` | Dark text rendered on top of `#F2B544` primary buttons. |

#### Project Indicator Colors (Hex Badges & Dots)
- **Project C7801:** `#6CB6EA` (Ocean Blue)
- **Project R5301:** `#B7A3F2` (Lilac Purple)
- **Project P5002:** `#56C8A8` (Teal Green)
- **Neutral / Inbox:** `#6B7A84` (Slate Gray)

### 2.2 Typography

- **UI Font:** `IBM Plex Sans` (or system sans-serif fallback). Clean, geometric, legible at small mobile scales.
  - Screen Titles: `20pt / 26px`, SemiBold
  - Section Headers: `13pt / 16px`, SemiBold, tracking `0.06em`
  - Body Text: `14pt – 15pt / 20px`, Regular
  - Captions / Meta: `12pt / 16px`, Regular
  - Smallest Allowed Text Floor: `12pt / 12px` (no micro-text below 12px).
- **Data & Monospace Font:** `IBM Plex Mono` (or system monospace). Used for:
  - Dates (`2026-10-16`, `Wed 30 Sep`)
  - Tag Pills (`#stability`, `#rcd`)
  - Task IDs (`TASK #14`)
  - Code blocks, formula metrics, status codes (`[IN_PROGRESS]`)

### 2.3 Component Primitives & Styling Rules

- **Corner Radii:**
  - Cards & Containers: `12px – 14px`
  - Inputs & Buttons: `10px – 12px`
  - Chips & Pills: Full pill (`999px` / `50%`)
  - Checkboxes: `6px – 7px`
- **Pills & Chips:** Outlined with `1px border`, optional left dot indicator (`8px diameter`). Selected state uses `16%` opacity background tint of the accent/project color + solid accent border.
- **Buttons:**
  - *Primary Button:* Solid `#F2B544`, text `#10161A`, font-weight `600`, minimum touch target height `48px – 52px`.
  - *Secondary / Outlined Button:* `#131B21` background, `#2F3E48` border, `#E8EEF1` text.
- **Look & Feel:** Utilitarian, precision naval engineering aesthetic. Uncluttered, high information density without feeling cramped, dark-first. Avoid generic consumer rounded bubbly aesthetics.

---

## 3. Scope & Explicit Boundary Guardrails

### 3.1 Functions to Include
1. **Browse & Create Notes:** Space-scoped folder tree (`/api/tree`), recent notes (`/api/notes/recent`), note creation (`POST /api/notes`) from blank or templates, rendered markdown reader, draft editor, `#tags` management, and linked task status indicators.
2. **Synced Custom Task Lists:** Synced with desktop `/api/views` (`view_type: "list"`), multi-select bulk operations, search/filters, and inline task creation.
3. **Synced Custom Kanban Boards:** Synced with desktop `/api/views` (`view_type: "kanban"`), column swipe/pager, rich cards, status moves with `status_flow` comment prompts, and inline task creation.
4. **Task Detail View:** Auto-saving bottom sheet for full task metadata, custom fields, linked note pill, and discussion comments thread.
5. **Co-Pilot AI Chat:** Streaming NDJSON chat (`/api/chat/stream`), context injection, model & effort selectors, slash prompts (`/api/prompts`), and `ask_first` note edit approvals.
6. **Browser & Gallery Share Receiver:** System share sheet target (`ACTION_SEND`) for URLs and photos, auto-fetching `<title>` metadata, photo upload to `.assets/`, and saving as a new note or appending to an existing note.

### 3.2 Explicit Exclusions (Must NOT be in the App)
1. **NO Gantt Chart:**
   - No Gantt timeline rendering, no milestone ticker/banners, and any saved views with `view_type: "gantt"` must be filtered out of mobile navigation and selectors.
2. **NO Remote Server File Opening:**
   - Any links or inline code pointing to workstation/SMB file paths (`file://`, `Y:\...`, `\\server\...`, `isLocalHref`) must render as **plain, inert monospace text**.
   - Do NOT provide click actions, file open buttons, or endpoints to `/api/local-files/*`.

---

## 4. App Navigation & Shell Architecture

The companion app utilizes a persistent top status bar and a **3-tab primary bottom navigation bar**:

```
+-------------------------------------------------------+
| [◆] [ Space: Naval Architecture ▾ ]     [ ↗ Share Demo ] | <- Top Shell
+-------------------------------------------------------+
|                                                       |
|                                                       |
|                   ACTIVE SCREEN VIEWPORT              |
|                                                       |
|                                                       |
+-------------------------------------------------------+
|   [ 📄 Notes ]      [ 🗂️ Tasks ]      [ 🤖 Co-Pilot ]   | <- Bottom Bar
+-------------------------------------------------------+
```

### Top Shell Elements (Persistent)
- **Status Bar:** Android network/battery/clock + Tailscale connected status indicator.
- **Space Switcher:** Tapping opens a dropdown/sheet listing available spaces (`GET /api/spaces`). Selecting a space switches the active `space_id` across Notes, Tasks, and Chat.
- **Quick Actions:** Instant search and contextual creation (`+`).

### Primary Bottom Navigation Tabs
1. **Notes (`/notes`):** Knowledge base browsing, recent notes, search, and note reading/editing.
2. **Tasks (`/tasks`):** Unified task hub with an instant toggle between **List View** and **Kanban View**, backed by synced saved views (`/api/views`).
3. **Co-Pilot (`/chat`):** AI assistant conversation, slash commands, tool execution progress, and note edit approvals.

---

## 5. Detailed Screen Specifications

---

### Screen 1: Notes Browser (`Notes` Tab)

**Purpose:** Primary entry point for reading, exploring, and authoring notes in the active Space.

#### UI Layout & Structure
1. **Header & Actions:**
   - Eyebrow: `KNOWLEDGE BASE`
   - Title: `Notes`
   - Action: Primary `+ New Note` button (opens New Note Sheet).
2. **Sub-Navigation & Search:**
   - Full-width search field: *"Search notes or #tags…"*.
   - Segmented control: **Tree** (hierarchical folder structure) | **Recent** (reverse chronological list of modified notes).
3. **Tree View Mode (`GET /api/tree?space_id=`):**
   - Hierarchical folder nodes (`FolderNode`).
   - Project folders (e.g., `C7801`, `R5301`, `P5002`) display an indicator dot in their project hex color and a `Project` pill badge.
   - Expandable/collapsible rows with note counts.
   - Individual note rows display: icon (`📄`), title, project tag pill, draft status badge (`draft` in amber outline vs. published), and right chevron.
   - Long-press / `⋮` menu on folder or note: **Rename**, **Duplicate**, **Move**, **Delete**.
4. **Recent View Mode (`GET /api/notes/recent?space_id=`):**
   - Flat list sorted by `modified` timestamp.
   - Card displays: Note title, relative timestamp (e.g., `14m ago`, `Yesterday`), parent folder path, and `#tags` pills.
5. **New Note Bottom Sheet (`POST /api/notes`):**
   - Title input.
   - Destination Folder selector (defaults to current folder or `<Project>/Notes-in`).
   - Template Picker: **Blank Note** or pre-configured space templates (e.g., *Meeting Prep*, *Design Decision*, *Quick Note*, *Email Note*).
   - Action: `Create Draft Note` button $\rightarrow$ opens Screen 2.

---

### Screen 2: Note Viewer & Draft Editor

**Purpose:** Comprehensive viewing of rendered markdown documentation and rich draft authoring.

#### UI Layout & Structure
1. **Header Bar:**
   - Back navigation button + breadcrumb (`C7801 / DESIGN`).
   - State indicator pill: `published` (neutral) vs. `draft · Saved` (amber).
   - Primary Toggle Button:
     - When `published`: displays **`Edit`** (switches note to draft via `PUT /api/notes/file`).
     - When `draft`: displays **`Publish`** (commits final draft to published).
2. **Metadata & Tags Strip:**
   - Note Title (editable input in draft mode, heading in published mode).
   - `#tags` horizontal flow with `×` remove buttons and `+ Add tag` autocomplete chip (queries `GET /api/spaces/{id}/tags`).
3. **Linked Tasks Bar (`GET /api/tasks?space_id=&note_path=`):**
   - Compact summary strip showing tasks connected to this note.
   - Displays task status badge (e.g., `[IN_PROGRESS]` in status color), title, and due date.
   - Tapping any linked task row opens **Screen 5 (Task Detail Sheet)**.
   - `+ Link task` button to attach an existing task or create a new linked task.
4. **Body Content Area:**
   - **Published View (Read-Only):**
     - Clean typography rendering headings, bullet/numbered lists, and interactive checklists.
     - Horizontally scrollable GFM tables with dark borders and alternating row shading.
     - KaTeX rendered mathematical formulas (display and inline).
     - Inline images (`GET /api/notes/image/{name}`) with pinch-to-zoom modal lightbox.
     - Inline reference pills:
       - `ref:task` $\rightarrow$ task icon, status pill, task title (tap opens Task Detail Sheet).
       - `ref:url` $\rightarrow$ globe icon, web page title.
       - *Local server paths (e.g., `Y:\...`, `\\server\...`):* rendered as **inert monospace code pills** with no click action.
   - **Draft Edit View:**
     - Auto-expanding markdown textarea with live auto-save debounced at 2 seconds (`PUT /api/notes/file`).
     - Sticky Mobile Formatting Toolbar above keyboard:
       - `H` (Heading level), `B` (Bold), `I` (Italic), `☑` (Checklist item).
       - `📷 Photo` (launches camera or device gallery $\rightarrow$ uploads to `POST /api/notes/image` and inserts markdown image).
       - `🔗 Link` (inserts web link pill or task reference pill).

---

### Screen 3: Custom Task Lists (`Tasks` Tab — List View)

**Purpose:** Synced tabular and list-based task management with multi-criteria filtering and bulk updates.

#### UI Layout & Structure
1. **Synced View Selector Bar:**
   - Top dropdown listing saved views (`GET /api/views?space_id=` filtered to `view_type == "list"` or `"backlog"`, excluding `"gantt"`).
   - Shows active view name (e.g., `📋 C7801 & R5301 List`, `📋 My Open Tasks`).
   - `+ View` button: allows saving the current filters as a new saved view (`POST /api/views`) that instantly syncs to the desktop sidebar.
   - View Options (`⋮`): Rename View, Duplicate View, Delete View.
   - Mode Toggle: Segmented button switching between **List** and **Kanban** view.
2. **Filter & Search Bar:**
   - Search input: filters across title, project, status, assignee, `#tag`, and custom fields.
   - Active Filter Chips Strip (horizontal scrolling):
     - `Project: C7801, R5301`
     - `Assignee: Jose`
     - `+ Filters` button (opens Advanced Filter Sheet supporting `priority[]`, `status[]`, `has_deadline`, date ranges, custom fields, and `Show archived`).
   - `Save view` button (enabled when active filters differ from saved view filters).
3. **Multi-Select Bulk Action Toolbar:**
   - Appears when $\ge 1$ task checkboxes are selected.
   - Displays count: `X selected`.
   - Actions: `Bulk edit…` (opens modal to set status, project, assignee, or priority across all selected tasks via `POST /api/tasks/bulk-update`), `Archive`, `Clear`.
4. **Task Item Rows:**
   - Multi-select checkbox.
   - Task title + `#tags` pills + linked note icon indicator.
   - Project badge (colored by project token: e.g. blue `● C7801`).
   - Status badge (colored according to space `status_colors`).
   - Due date (highlighted in `#F2B544` amber if overdue).
   - Assignee badge / avatar initials.
   - Custom field pills (e.g., dropdown options with their configured color borders).
   - Tapping the row (outside the checkbox) opens **Screen 5 (Task Detail Sheet)**.
5. **Inline Task Creation Bar:**
   - Pinned at the bottom of the list: `+ Add task to this list…`.
   - Tap opens inline row with pre-filled filter defaults (project, assignee, status) and immediate submit.

---

### Screen 4: Custom Kanban Boards (`Tasks` Tab — Kanban View)

**Purpose:** Visual workflow management with agile drag-and-drop or one-tap column transitions.

#### UI Layout & Structure
1. **Synced Board Selector Bar:**
   - Synced view dropdown (`GET /api/views?space_id=` filtered to `view_type == "kanban"`).
   - Active view name (e.g., `🗂️ C7801 Kanban`, `🗂️ All Active Sprint`).
   - `+ Board` button to create a new Kanban view.
   - Mode Toggle: Swapped to **Kanban** active.
2. **Filter Chips Bar:** Same space-aware filtering chips as List View.
3. **Mobile Column Pager Tabs:**
   - 4-column tab bar fitted cleanly to phone width:
     - `To do (X)` | `In progress (Y)` | `Blocked (Z)` | `Done (W)`
   - Displays task count per column.
   - Tapping a tab jumps immediately to that column; swipe gestures allow smooth horizontal paging between columns.
4. **Active Column Cards:**
   - Rich mobile Kanban card:
     - Title in high-contrast text.
     - Project tag (e.g., `● C7801`).
     - Badges: `blocked` (amber background if blocked), `milestone` badge.
     - Custom field pills (e.g., `Class: Lloyd's`).
     - `#tags` chips.
     - Linked note pill (e.g., `📄 stability.md`).
     - Due date (amber if overdue).
     - Assignee avatar / initials.
     - Quick Status Move button (`Move ▾`): opens bottom picker of allowed transitions based on `Space.status_flow`.
       - If transition requires comment: prompts with the **Status Change Comment Dialog** (`postStatusComment`).
   - Tapping anywhere on the card opens **Screen 5 (Task Detail Sheet)**.
5. **Inline Column Card Adder:**
   - Pinned to the bottom of the active column: `+ Add card to [Column Name]…`.
   - Allows instant task creation with title, project picker, and inline custom fields.

---

### Screen 5: Task Detail Bottom Sheet

**Purpose:** Comprehensive inspection and editing of a single task, accessible from List, Kanban, or Notes.

#### UI Layout & Structure
1. **Sheet Header:**
   - Drag handle + `TASK #<id>` caption + Space name.
   - Status badge indicator.
   - `Delete task` link (with confirmation).
   - `✕` Close button.
2. **Title & Tags Editor:**
   - Full-width editable multiline title (auto-saves on blur / debounce).
   - `#tags` chip flow with delete `×` and `+ Tag` input.
3. **2-Column Metadata Grid:**
   - **Status:** Dropdown filtered to allowed transitions (`allowedStatuses(space.status_flow)`). Prompts for comment if required.
   - **Priority:** Dropdown (`low`, `normal`, `high`, `urgent`).
   - **Due Date:** Native date picker (highlights in amber if overdue).
   - **Assignee:** Contact selector populated from `GET /api/people?space_id=`.
   - **Project:** Project picker (`GET /api/projects?space_id=`).
4. **Space Custom Fields Section:**
   - Dynamically generated from `Space.custom_fields_schema`:
     - Dropdown fields render with their custom option color bar.
     - Checkbox, date, number, and text custom fields render accordingly.
5. **Linked Note Section:**
   - Displays linked note reference pill (e.g., `📄 C7801/Design/Stability booklet.md`).
   - Tap jumps directly to Screen 2 (Note Viewer).
   - `Unlink` button or `+ Link note` picker.
6. **Description Box:**
   - Rendered markdown description with `Edit Description` action.
7. **Discussion & Activity Comments (`Task.comments`):**
   - Chronological list of user comments with author name, timestamp, and body text.
   - Input field: `Add a comment…` + `Post` button (`POST /api/tasks/{id}/comments`).

---

### Screen 6: Co-Pilot AI Chat (`Co-Pilot` Tab)

**Purpose:** Conversational pairing assistant scoped to the current active Space and documentation context.

#### UI Layout & Structure
1. **Control Header:**
   - **Context Banner:** Displays active space and current page/task context (e.g., `📍 Context: Stability booklet — freeboard check`). Tap to clear context.
   - **Access Mode Selector:** Dropdown offering `Ask first` (default) | `Read only` | `Write directly`.
   - **Model Selector:** Dropdown populated from `GET /api/models` (e.g., `gemini-2.5-pro (Local CLI)`, `claude-opus-4-6 (Local CLI)`).
   - **Reasoning Effort Selector:** `Effort: High` | `Effort: Auto` | `Effort: Low`.
2. **Conversation Stream (`POST /api/chat/stream`):**
   - User turn: Right-aligned card with user prompt and highlighted slash commands.
   - Tool Execution Strip: Collapsible status pills showing real-time agent activity:
     - `✓ Searching notes: "C7801 stability"`
     - `✓ Checking tasks: "C7801"`
     - `✓ Web search: "ISO 12217-1 freeboard requirements"`
   - Assistant turn: Left-aligned markdown card rendering rich text, code snippets, and mathematical formulas.
   - *Inert server paths:* server file paths cited in replies render as static code with no remote open action.
3. **Proposed Note Edit Approval Card (`ask_first` mode):**
   - Highlighted card with gold border and `PROPOSED NOTE EDIT` header.
   - Shows target file path (`C7801/Meetings/2026-10-16.md`).
   - Diff preview showing added/modified lines in green/red text.
   - Action Buttons: Primary `Approve & Save` (`POST /api/notes/apply-edit`) and `Reject`.
4. **Slash Command Menu Popup:**
   - Triggered by typing `/` or tapping the `/` shortcut button.
   - Lists Space prompts from `GET /api/prompts?space_id=`:
     - `/prep` — Draft meeting prep brief.
     - `/design-search` — Search local space design archives.
     - `/rcd` — Search RCD harmonized standards.
     - `/online-research` — Conduct deep technical investigation.
5. **Composer Bar:**
   - `/` shortcut button.
   - Auto-growing message input: *"Ask Co-Pilot or type / for commands…"*.
   - Send / Stop streaming button.

---

### Screen 7: Android Share Sheet Receiver

**Purpose:** Seamless mobile intake of links and pictures shared from Chrome, Gallery, or any Android app into the user's notes.

#### Android Intent Registration
- Triggered via `ACTION_SEND` (single link or image) and `ACTION_SEND_MULTIPLE` (multiple images) in `AndroidManifest.xml` with MIME types `text/plain` and `image/*`.
- Displays as a slide-up modal bottom sheet over the source application.

#### UI Layout & Structure
1. **Header:**
   - Co-Pilot brand mark + title: `Share to Daily Co-Pilot`.
   - `Cancel` button (dismisses and returns to source app).
2. **Shared Payload Preview Card:**
   - *When a URL is shared:*
     - App calls `GET /api/url-metadata?url=<shared_url>` in the background.
     - Renders rich web link pill with auto-fetched `<title>` and domain.
   - *When 1 or more images are shared:*
     - Horizontal thumbnail preview strip of the photos/screenshots with file sizes.
     - Explanatory note: *"Images will be uploaded to space `content/.assets/`"*.
3. **Destination Mode Segmented Toggle:**
   - **`Create new note`** | **`Add to existing note`**
4. **Mode A: Create New Note Form:**
   - Space Selector (defaults to active space).
   - Folder Selector (defaults to `<Project>/Notes-in` or `Inbox`).
   - Note Title Input (pre-populated with fetched web `<title>` or image timestamp).
   - Optional `#tags` field.
5. **Mode B: Add to Existing Note Form:**
   - Searchable picker listing recent notes (`GET /api/notes/recent?space_id=`).
   - User selects target note (e.g., `📄 Stability booklet — freeboard check.md`).
6. **Optional Commentary Field:**
   - Multiline input: *"Add a quick note or comment above the shared link/photo…"*.
7. **Submit Button:**
   - Primary full-width button: `Create Note & Save` or `Append to Note`.
   - On completion: displays toast confirmation with option to *"Open in Co-Pilot"* or seamlessly returns to the browser/camera.

---

## 6. Complete Backend API Route Reference

| Feature Area | Endpoint | Method | Purpose in Companion App |
| :--- | :--- | :--- | :--- |
| **Spaces** | `/api/spaces` | `GET` | Populate top Space Switcher and space preferences |
| **Notes: Tree** | `/api/tree?space_id=` | `GET` | Populate Screen 1 hierarchical folder tree |
| **Notes: Recent** | `/api/notes/recent?space_id=` | `GET` | Populate Screen 1 recent list and Screen 7 note picker |
| **Notes: Read/Write** | `/api/notes/file` | `GET`, `PUT` | Read note markdown & frontmatter; auto-save drafts |
| **Notes: Create** | `/api/notes` | `POST` | Create blank note or scaffold from template |
| **Notes: Assets** | `/api/notes/image` | `POST`, `GET` | Upload shared photos/screenshots to `.assets/`; fetch images |
| **Notes: Metadata** | `/api/url-metadata?url=` | `GET` | Fetch web page `<title>` for rich link pills |
| **Notes: Tags** | `/api/spaces/{id}/tags` | `GET` | Autocomplete for `#tag` pills across notes & tasks |
| **Tasks: List/Filter** | `/api/tasks?space_id=` | `GET` | Fetch tasks filtered by project, assignee, tag, status, custom fields |
| **Tasks: Detail** | `/api/tasks/{id}` | `GET`, `PATCH` | Fetch task details; auto-save field edits |
| **Tasks: Create** | `/api/tasks` | `POST` | Inline task creation in List, Kanban, and Notes |
| **Tasks: Bulk Update**| `/api/tasks/bulk-update` | `POST` | Bulk edit or archive ticked tasks from List View |
| **Tasks: Comments** | `/api/tasks/{id}/comments` | `POST`, `PATCH`, `DELETE` | Task discussion comments thread |
| **Views: Synced** | `/api/views?space_id=` | `GET`, `POST`, `PUT`, `DELETE` | Synced saved List & Kanban views (Gantt filtered out) |
| **Chat: Stream** | `/api/chat/stream` | `POST` | Streaming NDJSON AI conversation & tool progress |
| **Chat: Prompts** | `/api/prompts?space_id=` | `GET` | Populates `/` slash command menu |
| **Chat: Edit Approval**| `/api/notes/apply-edit`| `POST` | Commits approved `ask_first` note changes |
| **People** | `/api/people?space_id=` | `GET` | Assignee selector contacts directory |

---

## 7. Deliverables Checklist for Claude Design

When generating UI designs and wireframes based on this brief, Claude Design should deliver:

1. **Screen 1 (Notes Browser):** Tree view with project color dots and Recent view toggle, search bar, and New Note bottom sheet.
2. **Screen 2 (Note View/Editor):** Published markdown layout (with math, tables, images, and inert server path pill) + draft edit mode with mobile formatting bar.
3. **Screen 3 (Custom Task Lists):** Synced view selector, filter chips, checkable rows with custom field pills, multi-select bulk edit bar, and inline task adder.
4. **Screen 4 (Custom Kanban Boards):** Synced board selector, 4-column tabs with item counts, rich cards, status transition menu, and per-column card adder.
5. **Screen 5 (Task Detail Sheet):** Slide-up sheet with 2-column grid, dynamic custom fields, linked note pill, description, and comments thread.
6. **Screen 6 (Co-Pilot Chat):** Chat stream with context banner, model/effort selectors, tool call progress pills, proposed edit approval card, and `/` slash prompt menu.
7. **Screen 7 (Share Sheet Receiver):** Modal overlay showing shared link pill with fetched `<title>` + image thumbnail preview + New Note vs. Append to Existing Note toggle.
