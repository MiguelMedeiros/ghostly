import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { Root } from "../../../src/Root";
import { setStorageProfile } from "../../../src/lib/storage";
import { extensionHost } from "../host";
import { loadSettings } from "../../../src/lib/settings";
import { applyDocumentLanguage } from "../../../src/lib/documentLanguage";
import { databaseFor, followProfileSwitch, openPageProfile } from "../profile";

// Ghostly Browser renders the Desktop UI as is. What differs is below it: the
// platform modules come from @ghostly/browser, on top of the extension host.

// The local profile in use (WISP 04), the one the peer runs as: its chats, database and settings. The
// first profile keeps the original names, so an install from before profiles finds everything in place.
const profile = openPageProfile();
setStorageProfile(profile);
setDatabaseName(databaseFor(profile));
// Another tab switched: the peer follows it, and this page starts again as that profile.
followProfileSwitch(profile, () => location.reload());

setBrowserHost(extensionHost);
startSessionSync();
// The language on <html> before anything is painted (the I18nProvider keeps it in step from then on).
applyDocumentLanguage(loadSettings().language);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
