import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "../../../src/Root";
import { startSessionSync } from "../platform/sync";

// Ghostly Browser renders the Desktop UI as is. What differs is below it: the
// modules listed in vite.config.ts are swapped for the ones in ../platform.
startSessionSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
