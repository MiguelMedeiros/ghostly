import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { appFingerprint } from "@ghostly/core";
import type { AppPreview } from "@ghostly/browser/engine/apps";
import { DEFAULT_STORE_KEY } from "@ghostly/browser/engine/appDefaults";
import { AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const OTHER = "k5ir8khn4emft7zskr7qo7x876ntwxfiegooyz7moxucbd4u8aqt";

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null,
  install: "new", asks: ["chat"], run: { status: "ok" }, listedBy: [], unknownPublisher: false, stage: "screen",
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});

const storeLines = async (listedBy: AppPreview["listedBy"]) => {
  fakeEngine.on("appPreview", () => preview({ listedBy, unknownPublisher: !listedBy.some((s) => s.kind === "curated") }));
  renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
  return (await screen.findAllByTestId("app-store-line")).map((line) => line.textContent);
};

// A store's name is its own words: another store may take the official store's name, or the name of a store the person
// already has. Only its key tells them apart, so a store other than the official one is named with its fingerprint.
describe("the install screen's store lines", () => {
  it("name the official store by its name alone", async () => {
    expect(await storeLines([{ key: DEFAULT_STORE_KEY, name: "Ghostly Store", kind: "curated" }])).toEqual(["In Ghostly Store"]);
  });

  it("give another store that takes the official store's name its fingerprint", async () => {
    const lines = await storeLines([{ key: OTHER, name: "Ghostly Store", kind: "curated" }]);
    expect(lines).toEqual([`In Ghostly Store ${appFingerprint(OTHER)}`]);
  });

  it("tell two stores of one name apart", async () => {
    const lines = await storeLines([{ key: DEFAULT_STORE_KEY, name: "Ghostly Store", kind: "curated" }, { key: OTHER, name: "Ghostly Store", kind: "curated" }]);
    expect(lines).toEqual(["In Ghostly Store", `In Ghostly Store ${appFingerprint(OTHER)}`]);
  });

  it("give an index that only found it its fingerprint", async () => {
    const lines = await storeLines([{ key: OTHER, name: "Ghostly Store", kind: "indexed" }]);
    expect(lines[0]).toBe(`Found by Ghostly Store ${appFingerprint(OTHER)}`);
  });
});
