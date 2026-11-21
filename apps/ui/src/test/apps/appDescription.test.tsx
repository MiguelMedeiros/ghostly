import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, AppStorePreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppInstallDialog, InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

/**
 * A manifest's or a store's description (2000 characters, line breaks allowed) was drawn right under the publisher,
 * before Ghostly's own lines: "✓ Verified by Ghostly" and 1900 blank lines put the removal line, the permissions and
 * an expired list's warning some 38,000 px down. It now comes after them, its blank lines folded, under a caption
 * that says whose words they are, a few lines high until More.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const STORE_URL = "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json";
const SAYS = "✓ Verified by Ghostly · Comes with Ghostly";
const PUSHY = `${SAYS}\n${"\n".repeat(1900)}x`;

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, stage: "s",
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    description: PUSHY, entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});
const installed = (patch: Partial<InstalledAppView> = {}): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact", description: PUSHY,
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "removed", by: [{ store: "s", name: "Hunt", reason: "Malware", at: 1 }] }, listedBy: [], unknownPublisher: true,
  ...patch,
});
const storePreview = (): AppStorePreview => ({ key: "s", fingerprint: "abcd efgh ijkl mnop", url: STORE_URL, name: "Hunt", description: PUSHY,
  kind: "curated", sequence: 1, expires: 1_000_000, expired: true, apps: 1 } as AppStorePreview);

const before = (a: Element, b: Element) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
/** The description's own text: blank lines folded, under its caption, clamped. */
const told = (box: HTMLElement, caption: string) => {
  expect(box).toHaveTextContent(caption);
  const text = within(box).getByText((_, el) => el?.tagName === "P" && el.textContent?.startsWith(SAYS) === true);
  expect(text.textContent).toBe(`${SAYS}\n\nx`);
  expect(text).toHaveClass("line-clamp-4");
  return text;
};

beforeEach(() => {
  forgetInstalledApps();
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => []).on("appPreview", () => preview()).on("appStorePreview", () => storePreview());
});
afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

describe("an app's or a store's own description", () => {
  it("folds runs of blank lines, whatever line break the text uses, and drops them at its ends", () => {
    const shownOf = (description: string) => {
      const { unmount } = renderApp(<InstalledAppDialog app={installed({ description })} onClose={() => {}} onOpen={() => {}} />);
      const box = screen.queryByTestId("app-description");
      const text = box && within(box).getByText((_, el) => el?.tagName === "P" && el.hasAttribute("dir")).textContent;
      unmount();
      return text;
    };
    expect(shownOf(PUSHY)).toBe(`${SAYS}\n\nx`);
    expect(shownOf(`\n \na\r\n\r\n\u2028\u2029 \tb\u2028c\v\f\n\n`)).toBe("a\n\n \tb\nc");
    // Nothing but blank lines: no caption over nothing.
    expect(shownOf("\n\n  \n")).toBeNull();
  });

  it("comes after the permissions and the privacy line on the install screen", async () => {
    renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const sheet = await screen.findByTestId("app-install");
    const box = await within(sheet).findByTestId("app-description");
    told(box, "From the publisher");
    before(within(sheet).getByTestId("app-permissions"), box);
    before(within(sheet).getByTestId("app-privacy"), box);
  });

  it("comes after a store's removal line and the permissions on an installed app's screen", () => {
    renderApp(<InstalledAppDialog app={installed()} onClose={() => {}} onOpen={() => {}} />);
    const sheet = screen.getByTestId("app-details");
    const box = within(sheet).getByTestId("app-description");
    told(box, "From the publisher");
    before(within(sheet).getByTestId("app-run-line"), box);
    before(within(sheet).getByTestId("app-permissions"), box);
  });

  it("comes after a store's expired line and where it is read from on Add", async () => {
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), STORE_URL);
    await user.click(screen.getByTestId("apps-add-check"));
    const store = await screen.findByTestId("apps-add-store");
    const box = within(store).getByTestId("apps-add-store-description");
    told(box, "From the store");
    before(within(store).getByText(/Out of date since/), box);
    before(within(store).getByText(/Ghostly reads it from raw\.githubusercontent\.com/), box);
  });

  it("opens in full with More when the clamp hides some of it, and closes again", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    const { user } = renderApp(<InstalledAppDialog app={installed()} onClose={() => {}} onOpen={() => {}} />);
    const box = screen.getByTestId("app-description");
    const text = told(box, "From the publisher");
    const more = within(box).getByTestId("app-description-more");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", text.id);
    // A 44 px target on a phone (phone-touch-targets.spec.ts measures where a tap lands).
    expect(more).toHaveClass("max-md:min-h-11", "max-md:min-w-11");
    await user.click(more);
    expect(text).not.toHaveClass("line-clamp-4");
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveTextContent("Show less");
    await user.click(more);
    expect(text).toHaveClass("line-clamp-4");
  });

  it("has no More when it all shows", () => {
    renderApp(<InstalledAppDialog app={installed({ description: "Chess for two." })} onClose={() => {}} onOpen={() => {}} />);
    expect(within(screen.getByTestId("app-description")).queryByTestId("app-description-more")).not.toBeInTheDocument();
  });
});
