import { act } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openServiceView } from "../../../../web/src/svc/opener";
import { SERVICE_VIEW_ID, closeServiceView, parseServicesHost } from "../../../../web/src/svc/protocol";
import { CallOverlay } from "../../components/CallOverlay";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { setServiceViewCloser } from "../../lib/serviceWindows";
import { renderApp } from "../render";

// covers: services.web-open

/**
 * On the web a contact's app is drawn over the whole app (apps/web/src/svc/opener.ts), a call's windows with it: it
 * makes way for a call that rings or starts, and does not open over one. Desktop opens it in a window of its own.
 */
const host = parseServicesHost("https://*.svc.ghostly.example")!;
const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "End the call to open it.", tooSlow: "Too slow", offline: "Offline", retry: "Try again", hostError: () => null };
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

describe("a contact's app on the web, and a call", () => {
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
