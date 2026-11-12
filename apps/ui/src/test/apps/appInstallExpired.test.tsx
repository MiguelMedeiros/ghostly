import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

/**
 * The engine keeps what an install screen fetched for 10 minutes, and 4 screens' worth at most (`STAGED`). Install
 * pressed after that (a phone left on the screen, other screens opened since) was refused as "That took too long.
 * Check the app again." with no way to check it again: Install stayed, and every press was refused the same way until
 * the screen was closed and opened again. The screen now reads the app again: the same version asking the same
 * installs as pressed; anything else shows as it is now, to look at before Install.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const NEXT = "Fq8m0Uc3vH2JkTn4zR7wYx1aBdE5gS6iL9oP0rQ2sTu";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const EXPIRED = "expired: Fetch the app again";

const preview = (stage: string, patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, stage,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
});

/** The engine's staged screens: a stage installs only while it is held. */
let held: Set<string>;
let reads: number;
let read: () => AppPreview;
beforeEach(() => {
  forgetInstalledApps();
  held = new Set();
  reads = 0;
  read = () => preview(`${DIGEST}\nscreen-${reads}`);
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => [])
    .on("appPreview", () => { reads++; const p = read(); held.add(p.stage!); return p; })
    .on("appInstall", (params) => {
      const { stage } = params as { stage: string };
      if (!held.delete(stage)) throw new Error(EXPIRED);
      return installed();
    });
});
afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

describe("Install on a screen whose fetched app the engine no longer holds", () => {
  it("reads it again and installs the same version, asking the same, as pressed", async () => {
    const onInstalled = vi.fn(), onClose = vi.fn();
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={onClose} onInstalled={onInstalled} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    held.clear();
    await user.click(confirm);
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    expect(fakeEngine.callsTo("appInstall")).toEqual([
      { stage: `${DIGEST}\nscreen-1`, digest: DIGEST, grant: ["chat"], asks: ["chat"] },
      { stage: `${DIGEST}\nscreen-2`, digest: DIGEST, grant: ["chat"], asks: ["chat"] },
    ]);
  });

  it("shows another version found there, and installs it only on the next press", async () => {
    const onInstalled = vi.fn();
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} onInstalled={onInstalled} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    held.clear();
    read = () => preview(`${NEXT}\nscreen-${reads}`, { digest: NEXT, manifest: { ...preview("").manifest, version: "1.3.0", sequence: 8 } });
    await user.click(confirm);
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("That took too long. Check the app again.");
    expect(screen.getByTestId("app-install")).toHaveTextContent("1.3.0");
    expect(onInstalled).not.toHaveBeenCalled();
    expect(fakeEngine.callsTo("appInstall")).toHaveLength(1);
    await user.click(screen.getByTestId("app-install-confirm"));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(fakeEngine.callsTo("appInstall")[1]).toEqual({ stage: `${NEXT}\nscreen-2`, digest: NEXT, grant: ["chat"], asks: ["chat"] });
  });

  it("whose read again fails says why, and Install waits for Try again", async () => {
    const onInstalled = vi.fn();
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} onInstalled={onInstalled} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    held.clear();
    read = () => { throw new Error("offline: no network"); };
    await user.click(confirm);
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("You are offline.");
    expect(screen.getByTestId("app-install-confirm")).toBeDisabled();
    read = () => preview(`${DIGEST}\nscreen-${reads}`);
    await user.click(screen.getByTestId("app-install-retry"));
    await waitFor(() => expect(screen.getByTestId("app-install-confirm")).toBeEnabled());
    await user.click(screen.getByTestId("app-install-confirm"));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
  });
});
