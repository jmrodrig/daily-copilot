import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { SpaceProvider } from "./lib/space";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SpaceProvider>
        <App />
      </SpaceProvider>
    </BrowserRouter>
  </StrictMode>,
);
