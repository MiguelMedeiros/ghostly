import { act, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { openServiceView } from "../../../../web/src/svc/opener";
import { SERVICE_VIEW_ID, closeServiceView, parseServicesHost } from "../../../../web/src/svc/protocol";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { PeerServices } from "../../components/PeerServices";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.web-open

/**
 * A contact's app closed on the web (apps/web/src/svc/opener.ts) after the contact went offline: the strip and the
 * Services dialog dropped its Open button then, so the focus goes back to the dialog, or to the chat's composer, never
 * to the page's body (a keyboard or screen-reader user put back at the top of the page).
 */
const host = parseServicesHost("https://*.svc.ghostly.example")!;
const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "", tooSlow: "Too slow", offline: "Offline", retry: "Try again", blocked: "", unguarded: "", label: "Demo, shared by Ana", owner: "Ana's app", openLink: (site: string) => `Open ${site}`, hostError: () => null };
const ana: ChatSession = { id: "ana", profile: "paired-chat/1", mySeedB64: "seed-ana", peerPubKeyB64: "peer", encKeyB64: "enc", label: "Ana", messages: [], createdAt: 1 };
const ready = { status: "ready", transport: "iroh/1" } as NonNullable<LinkView["pairing"]>;
const link = (peerServices: LinkView["peerServices"]) => linkView({ profile: "paired-chat/1", pairing: ready, sessionOffers: { mine: ["services/1"], peer: ["services/1"] },
  capabilities: { files: true, payments: false, services: true }, peerServices });

/** The chat around the strip: its composer, which keeps the focus once the strip is gone. */
const chat = (
  <>
    <PeerServices peerPubKey="peer" onManage={() => {}} />
    <div data-composer><textarea data-testid="composer" aria-label="Message" /></div>
  </>
);
const PLACES = [
  { name: "the chat's apps strip", ui: chat, open: "open-service", back: () => screen.getByTestId("composer") },
  { name: "the chat's Services dialog", ui: <>{chat}<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} /></>, open: "chat-service-open", back: () => screen.getByTestId("chat-services") },
];

const openService = fakeEngine.openService;
let view: ReturnType<typeof renderApp>;
/** The contact's presence as apps/web/src/host.ts reads it: offline once their app no longer says what it shares. */
let gone = false;
const watchers = new Set<() => void>();
beforeAll(() => {
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});
beforeEach(() => {
  saveSession(ana);
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true, openServices: true };
  gone = false;
  fakeEngine.openService = () => openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", words,
    send: async () => { throw new Error("not asked"); },
    presence: { offline: () => gone, watch: (changed) => { watchers.add(changed); return () => watchers.delete(changed); } } });
});
afterEach(() => {
  closeServiceView();
  watchers.clear();
  fakeEngine.openService = openService;
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false, openServices: false };
  localStorage.clear();
});

describe.each(PLACES)("a contact's app opened from $name, closed once they went offline", ({ ui, open, back }) => {
  async function openThenOffline() {
    view = renderApp(ui);
    act(() => view.engine.update({ links: [link([{ id: "demo", type: "http", name: "Demo" }])] }));
    await view.user.click(await screen.findByTestId(open));
    await screen.findByTestId("service-view-close");
    act(() => { gone = true; view.engine.update({ links: [link(null)] }); for (const changed of watchers) changed(); });
    expect(screen.getByTestId("service-view-offline")).toBeVisible();
    expect(screen.queryByTestId(open)).toBeNull();
  }

  it("✕ gives the focus back to the place it opened from, not the page's body", async () => {
    await openThenOffline();
    await view.user.click(screen.getByTestId("service-view-close"));
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    expect(document.activeElement).toBe(back());
  });

  it("so does Escape", async () => {
    await openThenOffline();
    await view.user.keyboard("{Escape}");
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    expect(document.activeElement).toBe(back());
  });
});
