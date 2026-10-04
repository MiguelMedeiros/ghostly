import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { setBrowserHost } from "@ghostly/browser/host";
import { becomeThePeer } from "@ghostly/browser/inPageHost";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { openDeviceGate } from "@ghostly/browser/devices/gate";
import { setDeviceMirror } from "@ghostly/browser/devices/store";
import { setHandoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { handoffProfileHost, recoverHandoffPointer } from "./lib/handoffProfile";
import { desktopDeviceMirror } from "./desktop/deviceMirror";
import { isDesktopApp } from "./lib/externalLink";
import { Root } from "./Root";
import { createDesktopHost } from "./desktop/host";
import { nativeCallSupport } from "./desktop/nativeCalls";
import { setStorageProfile } from "./lib/storage";
import { activeProfileId, namespaceOf, setProfileBase, setRunningProfile } from "./lib/profiles";
import { loadSettings } from "./lib/settings";
import { applyDocumentLanguage } from "./lib/documentLanguage";

async function boot() {
  let profile = "";
  try {
    profile = await invoke<string>("get_profile");
  } catch {
    // running outside Tauri (browser dev) — no profile
  }
  // GHOSTLY_PROFILE gives this process a space of its own; inside it, the profile chosen in the app (WISP 04).
  setProfileBase(profile);
  // A profile a handoff moved whose pointer was lost: pointed at its state again before anything opens storage.
  await recoverHandoffPointer(activeProfileId());
  const profileId = activeProfileId();
  setRunningProfile(profileId);
  profile = namespaceOf(profileId);
  // Profiles share the WebView's storage area; each gets its own sessions, database and peer.
  if (profile) {
    setStorageProfile(profile);
    setDatabaseName(`ghostly_${profile}`);
  }
  // The profile's language on <html> before anything is painted (the I18nProvider keeps it in step from then on).
  applyDocumentLanguage(loadSettings().language);

  const root = createRoot(document.getElementById("root")!);
  await becomeThePeer(`ghostly-peer-${profile}`, () =>
    root.render(<p lang="en" style={{ padding: 24, font: "15px system-ui" }}>Ghostly is already running with this profile.</p>),
  );

  // The device state, before anything of the profile starts (WISP 06 § The gate). Desktop keeps it twice, in the
  // WebView's database and in a file Rust fsyncs, and takes the stricter of the two. A profile that never enrolled a
  // device is `single` and goes on exactly as before; on a standby the host starts device-link-only mode.
  if (isDesktopApp()) setDeviceMirror(desktopDeviceMirror(invoke));
  const gate = await openDeviceGate();

  const version = await getVersion().catch(() => "0.0.0");
  // What a handoff reads and writes of a profile's storage (WISP 06 § The handoff), before the host starts the engine.
  setHandoffProfileHost(handoffProfileHost(version, "desktop"));
  const host = createDesktopHost(version, await nativeCallSupport());
  setBrowserHost(host);
  if (gate.full) startSessionSync();
  addEventListener("pagehide", () => host.announceDeparture());
  // The app is exiting (apps/desktop's main.rs `on_run_event`): contacts hear it now, in the moment it waits for this.
  addEventListener("ghostly-departing", () => host.announceDeparture());

  root.render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

boot();
