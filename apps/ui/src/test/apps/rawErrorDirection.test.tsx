import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import type { LinkView } from "@ghostly/browser/shared/types";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { ChatAppPanel } from "../../components/apps/ChatAppPanel";
import { ChatAppsDialog } from "../../components/apps/ChatAppsDialog";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { IdentityActivity } from "../../components/identities/IdentityActivity";
import { Notice } from "../../components/ui/Notice";
import type { RunningApp } from "../../lib/apps/broker";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { setAppOpener } from "../../lib/apps/open";
import { setChatApp } from "../../lib/apps/running";
import { fakeEngine, linkView } from "../fakeEngine";
import { identitiesView, proofView, receivedView, sharedView } from "../identities/views";
import { renderApp } from "../render";

// covers: apps.page, app.i18n, apps.takedown, proofs.composer, proofs.recheck, proofs.public-activity

/**
 * An error the app has no words for is shown as it came: the engine's short English (problemText). In Arabic it took the
 * paragraph's direction, so "Internal error opening backing store for indexedDB.open." read with its full stop at the
 * start of the line, in a chat's + → Apps and on an installed app's Uninstall question. It keeps its own direction
 * (dir="auto", as an app's title does); the app's own Arabic words keep the page's.
 */
const RAW = "Internal error opening backing store for indexedDB.open.";

/** The element showing exactly this text is laid out in its own direction: a <bdi>, or dir="auto". */
const ownDirection = (root: HTMLElement, text: string) => {
  const shown = within(root).getByText(text);
  return shown.tagName === "BDI" || shown.getAttribute("dir") === "auto";
};

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const app: InstalledAppView = {
  ref: `${KEY}/chess`, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
};

afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

describe("in Arabic, an English error shown as it came", () => {
  it("keeps its own direction as a notice's title, and the app's Arabic words keep the page's", () => {
    renderApp(<>
      <Notice tone="error" testId="raw">{RAW}</Notice>
      <Notice tone="error" testId="said">Cashu متوقف في هذه المحادثة</Notice>
    </>, { language: "ar" });
    expect(ownDirection(screen.getByTestId("raw"), RAW)).toBe(true);
    // An Arabic line that starts with a Latin name would turn left to right under dir="auto": it is left to the page.
    expect(screen.getByTestId("said-title")).not.toHaveAttribute("dir");
  });

  it("keeps its own direction in a chat's + → Apps when the installed apps cannot be read", async () => {
    fakeEngine.on("appList", () => { throw new Error(RAW); });
    renderApp(<ChatAppsDialog linkId="link-1" name="Ana" onClose={() => {}} />, { language: "ar" });
    const line = await screen.findByTestId("chat-apps-error");
    expect(line).toHaveTextContent(RAW);
    expect(ownDirection(line, RAW)).toBe(true);
  });

  it("keeps its own direction on an installed app's Uninstall question when Uninstall fails", async () => {
    fakeEngine.on("appList", () => [app]).on("appBuiltIns", () => []).on("appUninstall", () => { throw new Error(RAW); });
    const { user } = renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />, { language: "ar" });
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    const alert = await within(screen.getByTestId("app-uninstall")).findByRole("alert");
    expect(alert).toHaveTextContent(RAW);
    expect(ownDirection(alert, RAW)).toBe(true);
  });
});

/** A paired chat with Alice, connected now. */
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });
/** The element with this test id once it shows the error, laid out in its own direction. */
async function shownOwnWay(testId: string) {
  const line = await screen.findByTestId(testId);
  expect(line).toHaveTextContent(RAW);
  return ownDirection(line, RAW);
}

describe("in Arabic, an English error shown as it came, on the lines beside an app and an identity", () => {
  it("keeps its own direction under an app's Open again when opening it again fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setAppOpener(async () => { throw new Error(RAW); });
    onTestFinished(() => { setAppOpener(null); setChatApp("link-1", null); });
    setChatApp("link-1", { ref: `${KEY}/chess`, title: "Chess", shown: true, wide: false, view: "chat", running: { stop: () => {} } as unknown as RunningApp, stopped: { why: "unresponsive" } });
    const { user } = renderApp(<ChatAppPanel linkId="link-1" sessionId="s1" contact={{ name: "Ana", named: true }} peerKey="peer" />, { language: "ar" });
    act(() => fakeEngine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1" })] }));
    await user.click(screen.getByTestId("mini-app-open-again"));
    expect(await shownOwnWay("mini-app-open-again-error")).toBe(true);
  });

  it("keeps its own direction in a contact's identities when they cannot be read", async () => {
    renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />, { language: "ar" });
    act(() => fakeEngine.update({ links: [paired({ identities: identitiesView({ error: RAW }) })] }));
    expect(await shownOwnWay("chat-identities-link-error")).toBe(true);
  });

  it("keeps its own direction on a contact's card back when a re-check fails", async () => {
    const { user } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    fakeEngine.on("recheckIdentityProof", () => { throw new Error(RAW); });
    act(() => fakeEngine.update({ links: [paired({ identities: identitiesView({ received: [receivedView()] }) })] }));
    await user.click(within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")[0]!);
    await user.click(await screen.findByTestId("chat-identity-recheck"));
    expect(await shownOwnWay("chat-identities-error")).toBe(true);
  });

  it("keeps its own direction in the composer's identity picker when the identities cannot be read", async () => {
    renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={() => {}} />, { language: "ar" });
    act(() => fakeEngine.update({ links: [paired({ identities: identitiesView({ error: RAW }) })] }));
    expect(await shownOwnWay("composer-identities-error")).toBe(true);
  });

  it("keeps its own direction on an identity's back in the composer when sharing it fails", async () => {
    const { user } = renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={() => {}} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    act(() => fakeEngine.update({ links: [paired()], identityProofs: [proofView()] }));
    fakeEngine.on("shareIdentityProof", () => { throw new Error(RAW); });
    await user.click(screen.getByTestId("composer-identity-use"));
    await waitFor(() => expect(screen.getByTestId("composer-identity-share")).toHaveFocus());
    await user.click(screen.getByTestId("composer-identity-share"));
    expect(await shownOwnWay("composer-identities-error")).toBe(true);
  });

  it("keeps its own direction on the Ghostly card's back in the composer when Share only this fails", async () => {
    const { user } = renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={() => {}} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    act(() => fakeEngine.update({ links: [paired({ myPubKeyZ32: KEY, identities: identitiesView({ shared: [sharedView({ id: "a", status: "accepted" })] }) })], identityProofs: [proofView({ id: "a" })] }));
    fakeEngine.on("withdrawIdentityProof", () => { throw new Error(RAW); });
    await user.click(screen.getByTestId("composer-identity-ghostly"));
    await waitFor(() => expect(screen.getByTestId("composer-identity-share")).toHaveFocus());
    await user.click(screen.getByTestId("composer-identity-share"));
    expect(await shownOwnWay("composer-identities-error")).toBe(true);
  });

  it("keeps its own direction under a post's picture in an identity's activity when it cannot be loaded", async () => {
    const now = Math.floor(Date.now() / 1000);
    fakeEngine.on("loadPublicPosts", () => ({ posts: [{ id: "p1", createdAt: now - 60, text: "Hello", images: [{ host: "nexus.pubky.app" }] }], more: false, hosts: ["nexus.pubky.app"], fetchedAt: now }));
    fakeEngine.on("loadPublicGraph", () => null);
    fakeEngine.on("loadPublicPostImage", () => { throw new Error(RAW); });
    const { user } = renderApp(<IdentityActivity provider="pubky" subject={"y".repeat(52)} profile={{ found: true, name: "Pat", hosts: ["nexus.pubky.app"], fetchedAt: now }} links={[]} />, { language: "ar" });
    await user.click(await screen.findByTestId("contact-activity-post-image"));
    expect(await shownOwnWay("contact-activity-post-image-error")).toBe(true);
  });
});
