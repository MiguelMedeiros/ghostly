import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { Root } from "../../src/Root";
import { becomeThePeer } from "@ghostly/browser/inPageHost";
import { webHost } from "./host";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { setStorageProfile } from "../../src/lib/storage";
import { activeProfileId, namespaceOf } from "../../src/lib/profiles";
import { loadSettings } from "../../src/lib/settings";
import { applyDocumentLanguage } from "../../src/lib/documentLanguage";

// The same UI and the same peer as the extension; only the host differs.
const root = createRoot(document.getElementById("root")!);

// The chosen local profile (WISP 04): its own chats, database, settings and single-peer lock. The
// default profile keeps the original names, so nothing existing moves.
const profile = namespaceOf(activeProfileId());
if (profile) { setStorageProfile(profile); setDatabaseName(`ghostly_${profile}`); }
// The profile's language on <html> before anything is painted (the I18nProvider keeps it in step from then on).
applyDocumentLanguage(loadSettings().language);

await becomeThePeer(profile ? `ghostly-peer-${profile}` : "ghostly-peer", () =>
  root.render(
    <div lang="en" style={{ height: "100vh", display: "grid", placeItems: "center", background: "#0b141a", color: "#8696a0", font: "15px system-ui", textAlign: "center", padding: 24 }}>
      <div>
        <div style={{ fontSize: 48 }}>👻</div>
        <p>Ghostly is already open in another tab.</p>
        <p style={{ fontSize: 13 }}>Close it and this tab takes over.</p>
      </div>
    </div>,
  ),
);

setBrowserHost(webHost);
startSessionSync();
addEventListener("pagehide", () => webHost.announceDeparture());

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
