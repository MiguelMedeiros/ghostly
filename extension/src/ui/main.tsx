import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { Root } from "../../../src/Root";
import { extensionHost } from "../host";

// Ghostly Browser renders the Desktop UI as is. What differs is below it: the
// platform modules come from @ghostly/browser, on top of the extension host.
setBrowserHost(extensionHost);
startSessionSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
