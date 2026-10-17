# Implementation Plan: Robust URL Metadata Extraction with OpenGraph, Twitter Card, and Slug Fallback

**Task ID:** `feat-url-metadata-slug-and-og-fallback`  
**Branch:** `feat-url-metadata-slug-and-og-fallback`  
**Implementer:** Jibby (Claude Code)  
**Lead Architect & Reviewer:** Nero (Google Antigravity / Gemini 3.1 Pro)

---

## 1. Overview & Root Cause

### Problem:
When pasting news articles or protected website URLs such as:
`https://www.publico.pt/2026/10/17/sociedade/noticia/2025-quase-metade-vagas-incentivos-medicos-ficou-preencher-2191629`
the link pill does not capture metadata properly, leaving the raw 104-character URL as the pill display text.

### Root Cause Analysis:
1. **WAF & Bot Interception:** `publico.pt` (and many news / media websites) is hosted behind CloudFront and AWS WAF. When automated HTTP clients request the page using Python's default `urllib` headers (`User-Agent: Mozilla/5.0`), the server returns HTTP `202 Accepted` with an AWS WAF JavaScript challenge (`challenge.js` / `window.awsWafCookieDomainList`) and an empty `<title></title>`, or HTTP `403 Forbidden`.
2. **Narrow HTML Extraction:** The existing `url_metadata` endpoint in `backend/main.py` only extracts `<title[^>]*>(.*?)</title>`. When that is empty or the request fails (403/202), `url_metadata` returns `{"title": null}`.
3. **No Fallback for Protected Pages:** Without a fallback, the frontend leaves the raw, unreadable URL in the document instead of extracting a human-readable title from the URL path.

---

## 2. Invariants & Safety Rules

- **Dev Server Inactivity:** Background development servers (uvicorn on port 8000, vite on port 5173) must remain **stopped** during all code editing.
- **Git Branch:** All work must take place on `feat-url-metadata-slug-and-og-fallback`.
- **Sync Rule:** `docs/AGENT_SETUP.md`, `GEMINI.md`, and `CLAUDE.md` must remain 100% identical.

---

## 3. Detailed Component Plan

### A. Backend: Multi-Tier Metadata Extraction & Slug Fallback (`backend/main.py`)

**Target File:** `backend/main.py`  
**Test File:** `backend/tests/test_links.py`

#### Implementation Steps:
1. In `backend/main.py`:
   - Implement `title_from_url_slug(url: str) -> str`:
     - Parses URL using `urllib.parse.urlparse`.
     - Extracts clean domain name (e.g. `publico.pt`, mapping common known domains: `publico.pt` -> `Público`, `github.com` -> `GitHub`, `wikipedia.org` -> `Wikipedia`, `theverge.com` -> `The Verge`, `medium.com` -> `Medium`, `nytimes.com` -> `The New York Times`, etc.).
     - Splits path segments, unquoting percent-encoding (`urllib.parse.unquote`), and filtering out empty segments and pure numeric date segments (e.g. `/2026/10/17/`).
     - Scans segments from the end to find the descriptive article slug.
     - Strips file extensions (`.html`, `.php`, etc.).
     - Strips trailing article IDs / hashes (e.g. `[-_](?:[0-9]+|[a-f0-9]{8,})$`).
     - Replaces hyphens and underscores with spaces (`re.sub(r"[-_]+", " ", ...)`).
     - If descriptive words are found (>= 3 characters):
       - Capitalizes the first character.
       - Returns `f"{formatted_words} · {domain_name}"`.
     - If no descriptive words are found, falls back to `domain_name`.
   - Update `url_metadata(url: str) -> UrlMetadata`:
     - Update request headers to a full modern browser profile:
       ```python
       headers = {
           "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
           "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
           "Accept-Language": "en-US,en;q=0.9,pt-PT;q=0.8,pt;q=0.7",
           "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
           "Sec-Ch-Ua-Mobile": "?0",
           "Sec-Ch-Ua-Platform": '"Windows"',
           "Upgrade-Insecure-Requests": "1",
       }
       ```
     - When HTML is returned, extract candidate titles in priority order:
       1. OpenGraph title: `<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']` (or content before property)
       2. Twitter title: `<meta[^>]+(?:property|name)=["']twitter:title["'][^>]+content=["']([^"']+)["']`
       3. HTML meta title: `<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']`
       4. HTML tag: `<title[^>]*>(.*?)</title>`
     - Decode entities (`html.unescape`) and normalize whitespace (`" ".join(raw.split())`).
     - Validate title: filter out bot challenge / error titles:
       ```python
       is_bot_challenge = bool(re.search(r"^(?:403\b|401\b|404\b|500\b|502\b|503\b|just a moment|attention required|access denied|security check|error: the request could not be satisfied|blocked|shieldsquare)", title, re.I))
       ```
     - If valid title is found: return `UrlMetadata(title=title)`.
     - If the network request raises an exception (HTTP 403/401/429/timeout/SSL) OR the extracted title is empty/a bot challenge:
       - Fall back to `title_from_url_slug(url)`!
       - Return `UrlMetadata(title=fallback_title)`.

2. In `backend/tests/test_links.py`:
   - Add unit tests for `title_from_url_slug`:
     - Publico news URL: `https://www.publico.pt/2026/10/17/sociedade/noticia/2025-quase-metade-vagas-incentivos-medicos-ficou-preencher-2191629` -> `2025 quase metade vagas incentivos medicos ficou preencher · Público`
     - The Verge article: `https://www.theverge.com/2024/3/15/24101234/apple-antitrust-lawsuit-doj-iphone` -> `Apple antitrust lawsuit doj iphone · The Verge`
     - Clean domain fallback when root URL: `https://github.com` -> `GitHub`
   - Add test verifying that when `urllib.request.urlopen` raises HTTP 403 or returns an AWS WAF 202 challenge page, `/api/url-metadata` successfully returns the slug-derived title instead of null.

---

### B. Frontend: Client-side Fallback & Title Display (`desktop/src/components/referencePill.tsx`)

**Target Files:**
- `desktop/src/components/referencePill.tsx`
- `desktop/src/components/NoteEditor.tsx`

#### Implementation Steps:
1. In `desktop/src/components/referencePill.tsx`:
   - Export client-side `titleFromUrlSlug(url: string): string`:
     - Mirrors the slug cleaning logic (extracts domain, removes article IDs/extensions, unescapes, replaces hyphens with spaces).
   - In `fetchUrlTitle(url: string, signal?: AbortSignal)`:
     - When `getJson<{ title: string | null }>` returns a non-empty title, use it.
     - If the fetch throws (e.g. backend offline or network failure) or returns null, fall back to `titleFromUrlSlug(url)` so the pill always gets a clean, human-readable display label!
2. In `desktop/src/components/NoteEditor.tsx`:
   - In `untitledUrlPills`:
     - Checks if pill label is empty, equal to `href`, or equal to `titleFromUrlSlug(href)` when replacing with newly fetched backend titles.

---

## 4. Verification & Testing Strategy

### Automated Testing:
1. **Backend Tests:**
   - Run `pytest backend/tests/test_links.py`.
   - Run `pytest backend/tests`.
2. **Frontend Type Check & Build:**
   - Run `npm run typecheck` in `desktop/`.
   - Run `npm run build` in `desktop/`.
3. **Playwright E2E Tests:**
   - Update `desktop/tests/url-title-and-bubble-dropdown.spec.ts` to include a test for pasting the user's specific URL:
     `https://www.publico.pt/2026/10/17/sociedade/noticia/2025-quase-metade-vagas-incentivos-medicos-ficou-preencher-2191629`
     verifying that the pill label updates to `2025 quase metade vagas incentivos medicos ficou preencher · Público` (or fetched title).

### User-Driven Manual Verification Gate:
1. Start the application servers via `start.cmd`.
2. Open any note in the desktop app.
3. Copy the URL:
   `https://www.publico.pt/2026/10/17/sociedade/noticia/2025-quase-metade-vagas-incentivos-medicos-ficou-preencher-2191629`
4. Paste it into the note editor at an empty cursor position.
5. Verify that the link pill immediately resolves to a clean, human-readable title (`2025 quase metade vagas incentivos medicos ficou preencher · Público`) instead of leaving the raw, ugly 104-character URL.
6. Paste into a task comment textarea and verify it resolves to the readable title there as well.
