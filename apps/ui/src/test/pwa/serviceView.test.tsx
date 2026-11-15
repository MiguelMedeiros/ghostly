import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { openServiceView } from "../../../../web/src/svc/opener";
import { SERVICE_VIEW_ID, closeServiceView, parseServicesHost } from "../../../../web/src/svc/protocol";
import { CallOverlay } from "../../components/CallOverlay";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { setServiceViewCloser, setServiceWindowsCloser, closeServiceWindows } from "../../lib/serviceWindows";
import { renderApp } from "../render";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { PeerServices } from "../../components/PeerServices";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";

// covers: services.web-open
describe("a contact's app on the web, and a call", () => {
  /**
   * On the web a contact's app is drawn over the whole app (apps/web/src/svc/opener.ts), a call's windows with it: it
   * makes way for a call that rings or starts, and does not open over one. Desktop opens it in a window of its own.
   */
  const host = parseServicesHost("https://*.svc.ghostly.example")!;
  const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "End the call to open it.", tooSlow: "Too slow", offline: "Offline", retry: "Try again", blocked: "", unguarded: "", label: "demo, shared by Demo bot", owner: "Demo bot's app", openLink: (site: string) => `Open ${site}`, hostError: () => null };
  const open = () => openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "demo",
    send: async () => { throw new Error("not asked"); }, words });

  const shown: { set: (on: "ring" | "call" | null) => void } = { set: () => {} };
  const show = (on: "ring" | "call" | null) => shown.set(on);
  function App() {
    const [on, setOn] = useState<"ring" | "call" | null>(null);
    useEffect(() => { shown.set = setOn; }, []);
    return (
      <>
        <button data-testid="open-service">Open</button>
        {on === "ring" && <IncomingCallNotification peerName="Bot" hasVideo={false} onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} />}
        {on === "call" && <CallOverlay callState="connected" pinned localStream={null} remoteStream={null} isMuted={false} isVideoOff remoteHasVideo={false} callStartedAt={null}
          peerName="Bot" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} />}
      </>
    );
  }

  beforeAll(() => { const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });
  afterEach(() => { act(() => show(null)); setServiceViewCloser(null); closeServiceView(); localStorage.clear(); });

  it("closes for a call that rings: the ringing call is seen, and has the keys", async () => {
    setServiceViewCloser(closeServiceView);
    const { getByTestId } = renderApp(<App />);
    getByTestId("open-service").focus();
    await open();
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
    act(() => show("ring"));
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    expect(getByTestId("open-service").closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(getByTestId("incoming-call"));
  });

  it("closes for a call that starts: its Mute and End call are in reach", async () => {
    setServiceViewCloser(closeServiceView);
    const { getByTestId } = renderApp(<App />);
    await open();
    act(() => show("call"));
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    expect(getByTestId("open-service").closest("[inert]")).toBeNull();
  });

  it("does not open over a call on screen, and says so; once the call is gone it opens", async () => {
    setServiceViewCloser(closeServiceView);
    renderApp(<App />);
    act(() => show("call"));
    await expect(open()).rejects.toThrow(words.callOn);
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    act(() => show(null));
    await open();
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
  });
});

// covers: services.web-open
describe("a contact's app closed once the contact went offline", () => {
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
});

// covers: services.web-open
describe("Escape on a contact's app", () => {
  /**
   * A contact's app opened from the chat's Shared services dialog is drawn over that dialog: the Escape that closes the
   * app is spent there, and the dialog the person opened it from is still open under it, as ✕ leaves it.
   */
  const words = { unreachable: "", failed: "", close: "Close", callOn: "", tooSlow: "", offline: "", retry: "", blocked: "", unguarded: "", label: "Demo", owner: "Not Ghostly", openLink: (site: string) => `Open ${site}`, hostError: () => null };

  beforeAll(() => {
    // happy-dom would load the bridge page from the network: nothing here needs it.
    const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });

  afterEach(() => closeServiceView());

  it("Escape on a contact's app closes the app alone, not the Shared services dialog under it", async () => {
    const onClose = vi.fn();
    renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={onClose} />);
    expect(screen.getByTestId("chat-services")).toBeInTheDocument();
    // The dialog's own history entry is there before the person can tap Open in it.
    await waitFor(() => expect(typeof (history.state as Record<string, unknown> | null)?.ghostlyLayer).toBe("number"));
    await openServiceView({ host: parseServicesHost("https://*.svc.ghostly.example")!, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", send: () => new Promise(() => {}), words });
    const close = screen.getByTestId("service-view-close");
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: "Escape" });
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    // Nor once the view's history entry is left, back on the dialog's.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-services")).toBeInTheDocument();

    // The next Escape is the dialog's.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// covers: settings.lock.idle
describe("a contact's app and the lock", () => {
  /**
   * A person using a contact's app on the web is using Ghostly: their taps and keys go to the app's frame, never to the
   * Ghostly page, and the lock locked them out after its time and closed the app with what they typed. The browser's
   * activation, which real input in a frame gives the page above it, counts; left alone, the lock comes as before.
   */
  const MINUTE = 60_000;
  const words = { unreachable: "", failed: "", close: "Close", callOn: "", tooSlow: "", offline: "", retry: "", blocked: "", unguarded: "", label: "Demo", owner: "Not Ghostly", openLink: (site: string) => `Open ${site}`, hostError: () => null };
  const activation = { isActive: false };

  function Probe() {
    const { isLocked } = useLockScreen();
    return <p data-testid="locked">{String(isLocked)}</p>;
  }

  const locked = () => screen.getByTestId("locked").textContent;
  const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  /** A tap in the app: the page is active for the next 5 seconds, as Chromium keeps it. */
  const tap = async () => {
    activation.isActive = true;
    await awake(5_000);
    activation.isActive = false;
  };

  beforeAll(() => {
    // happy-dom would load the bridge page from the network: nothing here needs it.
    const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });

  beforeEach(async () => {
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
    activation.isActive = false;
    vi.useFakeTimers();
    // The web host's: the lock closes the view (apps/web/src/host.ts).
    setServiceWindowsCloser(closeServiceView);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 1 } }));
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(locked()).toBe("false");
    await openServiceView({ host: parseServicesHost("https://*.svc.ghostly.example")!, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", send: () => new Promise(() => {}), words });
  });

  afterEach(() => {
    closeServiceView();
    setServiceWindowsCloser(null);
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    delete (navigator as { userActivation?: unknown }).userActivation;
  });

  it("taps and keys in a contact's app keep the lock away while the person uses it; left alone, it locks and closes the app", async () => {
    // Two and a half minutes of use, past twice the lock time.
    for (let i = 0; i < 5; i++) {
      await awake(25_000);
      await tap();
    }
    expect(locked()).toBe("false");
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();

    await awake(MINUTE);
    expect(locked()).toBe("true");
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  });

  it("an app on screen with nobody using it keeps nothing unlocked", async () => {
    await awake(MINUTE + 1_000);
    expect(locked()).toBe("true");
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  });
});

describe("a contact's app opening as the profile locks", () => {
  /**
   * The profile locking while a contact's app is still on its way (its address worked out, before it is drawn) closes
   * nothing yet: the app is never drawn, so nothing behind the lock answers it, and the lock screen stays usable.
   */
  const words = { unreachable: "", failed: "", close: "Close", callOn: "", tooSlow: "", offline: "", retry: "", blocked: "", unguarded: "", label: "Demo", owner: "Not Ghostly", openLink: (site: string) => `Open ${site}`, hostError: () => null };
  const open = () => openServiceView({ host: parseServicesHost("https://*.svc.ghostly.example")!, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", send: () => new Promise(() => {}), words });

  beforeAll(() => {
    // happy-dom would load the bridge page from the network: nothing here needs it.
    const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });

  let root: HTMLElement;
  beforeEach(() => {
    // The web host's: the lock closes the view (apps/web/src/host.ts).
    setServiceWindowsCloser(closeServiceView);
    root = document.createElement("div");
    root.id = "root";
    root.append(document.createElement("dialog"));
    document.body.append(root);
  });

  afterEach(() => {
    closeServiceView();
    setServiceWindowsCloser(null);
    root.remove();
  });

  it("a lock while the app opens draws nothing and leaves the lock screen usable", async () => {
    const opening = open();
    closeServiceWindows();
    await expect(opening).rejects.toThrow();
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
  });

  it("with no lock it opens, and a later lock closes it", async () => {
    await open();
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
    expect(root.hasAttribute("inert")).toBe(true);
    closeServiceWindows();
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
  });
});
