# Implementation Plan: PWA Support

## 1. Overview
The user wants to install the app as a Progressive Web App (PWA) on Chrome/Mobile. This requires a properly configured Web App Manifest (including a `start_url`) and a registered Service Worker.

We will use `vite-plugin-pwa` to auto-generate the Service Worker for offline asset caching and inject the manifest.

## 2. Requirements

### A. Install Plugin
- In `desktop/`, run `npm install -D vite-plugin-pwa`.

### B. Configure Vite PWA
- Update `desktop/vite.config.ts` to import `VitePWA` from `vite-plugin-pwa`.
- Add `VitePWA(...)` to the `plugins` array.
- Configure it to use `registerType: 'autoUpdate'`.
- Pass the existing `site.webmanifest` data into the `manifest` property of the plugin, but be sure to add `"start_url": "/"`. 
  - Ensure the `icons` array matches the files currently in `public/` (icon-192.png, icon-512.png, icon-maskable-512.png).
  - Example:
    ```javascript
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: "Daily Copilot",
        short_name: "Copilot",
        start_url: "/",
        display: "standalone",
        theme_color: "#101820",
        background_color: "#101820",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      }
    })
    ```

### C. Clean up HTML
- In `desktop/index.html`, remove the static `<link rel="manifest" href="/site.webmanifest">`. The `vite-plugin-pwa` will automatically inject the generated manifest link.
- Delete the static `desktop/public/site.webmanifest` file since it's now handled by the plugin.

## 3. Execution
1. Read this plan.
2. Checkout a new branch `phase-pwa` from `main`.
3. Apply the changes.
4. Run `npm run build` to verify the service worker and manifest are generated in the `dist` folder.
5. Stage and commit to `phase-pwa`.
