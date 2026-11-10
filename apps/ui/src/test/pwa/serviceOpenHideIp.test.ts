import { afterEach, expect, it, vi } from "vitest";
import { SERVICE_VIEW_ID } from "../../../../web/src/svc/protocol";

// The web build's own (apps/web/src/env.d.ts), for the web host this test loads; stubbed below.
declare global {
  const __APP_VERSION__: string;
  const __APP_BUILD__: string;
}

// covers: settings.network.relay-only

/**
 * Hide my IP from contacts on the web: no policy the page can send keeps Chromium from connecting to a server a frame
 * in a contact's app points at (its "Preload pages" connects first), so the web app opens no contact's app while the
 * setting is on, as the extension and `ghostly service open` do, and says why.
 */
async function webHost() {
  vi.stubGlobal("__APP_VERSION__", "0.0.0");
  vi.stubGlobal("__APP_BUILD__", "test");
  vi.stubEnv("VITE_SERVICES_HOST", "https://*.svc.ghostly.example");
  vi.resetModules();
  return (await import("../../../../web/src/host")).webHost;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("opens no contact's app while Hide my IP from contacts is on, and says why", async () => {
  const host = await webHost();
  await expect(host.openService!("o".repeat(52), "demo", "ybndrfg8ejkmcpqx", true))
    .rejects.toThrow("A contact's app does not open in the web app while Hide my IP from contacts is on");
  expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
});
