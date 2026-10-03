# Implementation Plan: Phase 4.1 - Desktop Web App Scaffolding
**Task ID:** phase-4.1

## Goal
Scaffold the browser-based desktop application using React, Vite, and Tailwind CSS. The app should implement a baseline layout shell (Sidebar + Content Area) styled strictly in dark mode using our established design tokens.

## Scope
- Initialize a Vite + React + TypeScript project inside the `desktop/` directory. (You can overwrite the existing placeholder `package.json`).
- Install and configure `tailwindcss`, `postcss`, and `autoprefixer`.
- Configure `tailwind.config.js` to read (or map) the color values from `shared/design-tokens.json` (Surface Raised, Text Primary, Accent, etc.). 
- Force the HTML to always render in dark mode.
- Set up `react-router-dom` to handle basic navigation.
- Create a `Layout.tsx` component that provides:
  - A collapsible or fixed left sidebar navigation with links to: "Dashboard", "Projects", "Knowledge Base".
  - A main content area.
- Create a placeholder `Dashboard.tsx` view that fetches and displays a simple sanity-check (e.g., hitting the `/health` endpoint of our FastAPI backend).
- Configure Vite proxy so that API calls to `/api` are routed to `http://127.0.0.1:8000` to avoid CORS issues during development.

## Relevant Context
- The design should feel like a calm, engineering-grade tool. Use the dark slate background and high-contrast text defined in the tokens.
- We are using React and Vite because it provides the fast, interactive rendering needed for the upcoming live Gantt chart and Markdown note editor.

## Files to Modify / Create
- `desktop/package.json` (Overwrite)
- `desktop/vite.config.ts` (New)
- `desktop/tailwind.config.js` / `postcss.config.js` (New)
- `desktop/src/main.tsx` (New)
- `desktop/src/App.tsx` (New)
- `desktop/src/components/Layout.tsx` (New)
- `desktop/src/pages/Dashboard.tsx` (New)

## User-Driven Manual Test Plan
1. Open PowerShell and navigate to `desktop/`.
2. Run `npm install` and then `npm run dev`.
3. Ensure the FastAPI backend is running on port 8000 (`uvicorn main:app --host 0.0.0.0 --port 8000`).
4. Open the browser to the local Vite URL (e.g., `http://localhost:5173`).
5. Verify the dark-mode layout renders, the sidebar works, and the Dashboard successfully pings the backend `/health` endpoint.

## Out of Scope
- Actually rendering the live Gantt chart.
- The Co-Pilot Chat pane UI.
