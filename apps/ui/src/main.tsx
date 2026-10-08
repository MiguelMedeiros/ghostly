import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { setBrowserHost } from "@ghostly/browser/host";
import { becomeThePeer } from "@ghostly/browser/inPageHost";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { openDeviceGate } from "@ghostly/browser/devices/gate";
import { setDeviceMirror } from "@ghostly/browser/devices/store";
import { setHandoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { handoffProfileHost, recoverHandoffPointer } from "./lib/handoffProfile";
import { desktopDeviceMirror } from "./desktop/deviceMirror";
import { isDesktopApp } from "./lib/externalLink";
import { Root } from "./Root";
import { createDesktopHost } from "./desktop/host";
import { nativeCallSupport } from "./desktop/nativeCalls";
import { setProfileBase } from "./lib/profiles";
import { openProfile } from "./lib/profileStart";
import { listen } from "@tauri-apps/api/event";
import { setAppOpener } from "./lib/apps/open";
import { desktopOpener } from "./lib/apps/desktopOpener";
import { appWithContact } from "./lib/apps/running";
import { loadSettings } from "./lib/settings";
import { locales } from "./locales";
import { translateWith } from "./locales/translate";
import { servicesPlatform } from "./lib/platform";

async function boot() {
  let profile = "";
  try {
    profile = await invoke<string>("get_profile");
  } catch {
    // running outside Tauri (browser dev) — no profile
  }
  // GHOSTLY_PROFILE gives this process a space of its own; inside it, the profile chosen in the app (WISP 04).
  setProfileBase(profile);
  // A profile a handoff moved whose pointer was lost is pointed at its state again before anything opens storage. Each
  // profile gets its own sessions, database and peer (they share the WebView's storage area), and its language on <html>.
  profile = await openProfile(recoverHandoffPointer);

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
  // Mini-apps (WISP 1200) open in windows of their own, each with its broker here (lib/apps/desktopOpener.ts).
  // Its window is named after the app and the contact ("Chess with Ana"), in the profile's language.
  const windowTitle = (title: string, linkId: string | null) => {
    const language = loadSettings().language;
    return appWithContact(title, linkId, translateWith(locales[language] || locales.en, locales[language] ? language : "en"));
  };
  setAppOpener(desktopOpener({ apps: () => servicesPlatform?.apps, invoke, listen, windowTitle }));
  if (gate.full) startSessionSync();
  addEventListener("pagehide", () => host.announceDeparture());
  // The app is exiting (apps/desktop's lib.rs `on_run_event`): contacts hear it now, in the moment it waits for this.
  addEventListener("ghostly-departing", () => host.announceDeparture());

  root.render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

boot();
