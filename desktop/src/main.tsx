import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import App from "./App";
import { VoiceRecordingProvider } from "./context/VoiceRecordingContext";
import { SpaceProvider } from "./lib/space";
import { ErrorBoundary } from "./ErrorBoundary";
import "./index.css";

// A data router, with the app's own <Routes> under one catch-all route: it lets a page block navigation away from
// it (useBlocker: the note page while a recording is running), the browser's back and forward buttons included.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <SpaceProvider>
        <VoiceRecordingProvider>
          <App />
        </VoiceRecordingProvider>
      </SpaceProvider>
    ),
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
