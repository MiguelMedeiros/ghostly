import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { setBrowserHost } from "@ghostly/browser/host";
import { becomeThePeer } from "@ghostly/browser/inPageHost";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { Root } from "./Root";
import { createDesktopHost } from "./desktop/host";
import { setStorageProfile } from "./lib/storage";

async function boot() {
  let profile = "";
  try {
    profile = await invoke<string>("get_profile");
  } catch {
    // running outside Tauri (browser dev) — no profile
  }
  // Profiles share the WebView's storage area; each gets its own sessions, database and peer.
  if (profile) {
    setStorageProfile(profile);
    setDatabaseName(`ghostly_${profile}`);
  }

  const root = createRoot(document.getElementById("root")!);
  await becomeThePeer(`ghostly-peer-${profile}`, () =>
    root.render(<p style={{ padding: 24, font: "15px system-ui" }}>Ghostly is already running with this profile.</p>),
  );

  const host = createDesktopHost(await getVersion().catch(() => "0.0.0"));
  setBrowserHost(host);
  startSessionSync();
  addEventListener("pagehide", () => host.announceDeparture());

  root.render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

boot();
