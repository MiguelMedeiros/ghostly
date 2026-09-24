import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { Root } from "../../../src/Root";
import { extensionHost } from "../host";
import { loadSettings } from "../../../src/lib/settings";
import { applyDocumentLanguage } from "../../../src/lib/documentLanguage";

// Ghostly Browser renders the Desktop UI as is. What differs is below it: the
// platform modules come from @ghostly/browser, on top of the extension host.
setBrowserHost(extensionHost);
startSessionSync();
// The language on <html> before anything is painted (the I18nProvider keeps it in step from then on).
applyDocumentLanguage(loadSettings().language);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
