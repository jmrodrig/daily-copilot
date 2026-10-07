# Implementation Plan: Brand Integration

## 1. Overview
The user provided a brand package in `docs/brand`. We need to integrate the favicons, stylesheets, fonts, and colors into the web app, ensuring the new style overrides the existing hardcoded design tokens.

## 2. Asset Migration
- Copy all files from `docs/brand/favicon/` into `desktop/public/`.
- Copy `docs/brand/logo/mark-adaptive.svg` into `desktop/public/logo/` (create the directory).
- Copy `docs/brand/styles/brand.css` into `desktop/public/styles/` (create the directory).

## 3. Update `index.html`
- In `desktop/index.html`, add the brand's `<link>` and `<meta>` tags exactly as specified in `docs/brand/README.md`. 
- Ensure the pathing matches the public directory structure.

## 4. Decouple Tailwind and Map CSS Variables
- The current `desktop/tailwind.config.js` imports `shared/design-tokens.json` (which contains hardcoded dark-mode hex values).
- Because `brand.css` supports dynamic Light/Dark mode via CSS variables (`--dc-bg`, `--dc-fg`, etc.), you must **stop using** `shared/design-tokens.json` in `tailwind.config.js`.
- Hardcode the Tailwind config colors and fonts to map directly to the CSS variables so the app dynamically respects the user's OS color scheme.
  - Example mapping:
    - `background`: `"var(--dc-bg)"`
    - `surface`: `{ raised: "var(--dc-surface)", panel: "var(--dc-bg)", active: "var(--dc-stone-200)", hover: "var(--dc-stone-100)" }` (Use your best judgment to map to the neutral/semantic tokens in brand.css).
    - `text`: `{ primary: "var(--dc-fg)", secondary: "var(--dc-muted)", muted: "var(--dc-stone-400)" }`
    - `border`: `{ default: "var(--dc-line)", light: "var(--dc-line)", strong: "var(--dc-muted)" }`
    - `accent`: `{ primary: "var(--dc-accent)", soft: "var(--dc-accent-text)", DEFAULT: "var(--dc-accent)" }`
  - Update `fontFamily.sans` to use `var(--dc-font-ui)` if it exists, or just hardcode to `IBM Plex Mono` / `Cinzel` as per the README.
  - *Note: Leave the `shared/design-tokens.json` file alone for now, just don't import it in tailwind.*

## 5. Add Brand Logo to UI
- Open `desktop/src/components/Sidebar.tsx` (or `Layout.tsx` depending on what makes visual sense for a global header).
- At the top of the Sidebar navigation, insert the `mark-adaptive.svg` logo and the brand name "Daily Copilot" (apply the `.dc-wordmark` CSS class to the text if appropriate, or use the SVG lockup).

## 6. Execution & Verification
1. Read this plan.
2. Make all file copies and edits on a new branch `phase-brand`.
3. Run `npm run build` to verify Tailwind compiles.
4. Commit your changes.
