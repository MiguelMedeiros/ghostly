import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { appFingerprint } from "@ghostly/core";
import type { AppPreview } from "@ghostly/browser/engine/apps";
import { DEFAULT_STORE_KEY } from "@ghostly/browser/engine/appDefaults";
import { AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.updates

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const OTHER = "k5ir8khn4emft7zskr7qo7x876ntwxfiegooyz7moxucbd4u8aqt";

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null,
  install: "update", asks: [], run: { status: "ok" }, listedBy: [{ key: DEFAULT_STORE_KEY, name: "Ghostly Store", kind: "curated" }], unknownPublisher: false, stage: "screen",
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.3.0", sequence: 8, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});

const open = async (patch: Partial<AppPreview>) => {
  fakeEngine.on("appPreview", () => preview(patch));
  renderApp(<AppInstallDialog source={{ card: { ref: REF, url: URL_, sequence: 8 } }} onClose={() => {}} />);
  await screen.findByTestId("app-install-confirm");
};

// An app installed from a store takes only the versions that store lists. An update by link or card ends that (WISP
// 1200 § Updates and rollback): the screen said "Update" and "In Ghostly Store", as if the store still covered it.
describe("an install screen whose Install ends the app's store pin", () => {
  it("says which store's hold ends, before Install", async () => {
    await open({ leavesStore: { key: DEFAULT_STORE_KEY, name: "Ghostly Store" } });
    expect(screen.getByTestId("app-install-leaves-store").textContent).toBe(
      "Chess now takes updates only once Ghostly Store lists them. Installing this version ends that: its updates then come from its publisher's links.");
  });

  it("names a store other than the official one with its fingerprint after it", async () => {
    await open({ leavesStore: { key: OTHER, name: "Ghostly Store" } });
    expect(screen.getByTestId("app-install-leaves-store").textContent).toContain(`once Ghostly Store lists them. Installing this version ends that: its updates then come from its publisher's links. ${appFingerprint(OTHER)}`);
  });

  // Install from another store's listing pins the app to that store: its updates do not then come from the publisher.
  it("from another store's listing, says the updates then wait for this store", async () => {
    await open({ leavesStore: { key: DEFAULT_STORE_KEY, name: "Ghostly Store", to: OTHER }, listedBy: [{ key: OTHER, name: "Other store", kind: "curated" }] });
    const line = screen.getByTestId("app-install-leaves-store").textContent;
    expect(line).toBe("Chess now takes updates only once Ghostly Store lists them. Installing this version from here ends that: its updates then come only once this store lists them.");
    expect(line).not.toContain("publisher");
  });

  it("names a store with no index read by its fingerprint", async () => {
    await open({ leavesStore: { key: OTHER } });
    expect(screen.getByTestId("app-install-leaves-store").textContent).toContain(`once ${appFingerprint(OTHER)} lists them`);
  });

  it("says nothing when the pin stays", async () => {
    await open({});
    expect(screen.queryByTestId("app-install-leaves-store")).toBeNull();
  });
});
