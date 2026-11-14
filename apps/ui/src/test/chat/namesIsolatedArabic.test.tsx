import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import { ChatHoldLine } from "../../components/ChatHoldDialog";
import type { CallDevices } from "../../hooks/useCallDevices";
import type { PeerHoldState } from "../../lib/platform";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * A contact's or a device's name in the call's screen-share and device notices and in the chat's held line, in Arabic:
 * each its own <bdi>, as the sentence's other names are. Put in plainly, a bracket group with a digit in it took the
 * sentence's right-to-left direction and was drawn on the other side of the Latin name: "(2) Ana",
 * "(046d:082d) HD Pro Webcam C920".
 */

const WEBCAM = "HD Pro Webcam C920 (046d:082d)";

/** The <bdi> holding exactly this name inside the element, if any. */
const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].some((bdi) => bdi.textContent === name);

const devices = (notice: CallDevices["notice"]): CallDevices => ({
  list: { audioinput: [], videoinput: [], audiooutput: [], defaults: {}, named: true },
  current: { audioinput: "", videoinput: "", audiooutput: "" },
  speaker: undefined,
  speakers: false,
  choose: vi.fn(),
  notice,
  dismiss: vi.fn(),
  switchBack: vi.fn(),
  hold: vi.fn(),
});

function call(props: { peerName?: string; isScreenSharing?: boolean; remoteIsScreenSharing?: boolean; devices?: CallDevices | null }) {
  return (
    <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff remoteHasVideo={false}
      callStartedAt={Date.now()} peerName={props.peerName ?? "Ana"} onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()}
      isScreenSharing={props.isScreenSharing ?? false} remoteIsScreenSharing={props.remoteIsScreenSharing} devices={props.devices} />
  );
}

describe("names in Arabic sentences, each isolated", () => {
  it("the contact sharing their screen", () => {
    renderApp(call({ peerName: "Ana (2)", remoteIsScreenSharing: true }), { language: "ar" });
    const notice = screen.getByTestId("call-sharing");
    expect(notice).toHaveTextContent("Ana (2) يشارك شاشته");
    expect(isolated(notice, "Ana (2)")).toBe(true);
  });

  it("both of you sharing your screens", () => {
    renderApp(call({ peerName: "Ana (2)", isScreenSharing: true, remoteIsScreenSharing: true }), { language: "ar" });
    const notice = screen.getByTestId("call-sharing");
    expect(notice).toHaveTextContent("أنت وAna (2) تشاركان شاشتيكما");
    expect(isolated(notice, "Ana (2)")).toBe(true);
  });

  it.each(["lost", "gone", "failed", "back"] as const)("the device notice (%s)", (type) => {
    renderApp(call({ devices: devices({ kind: "videoinput", type, name: WEBCAM, id: "cam" }) }), { language: "ar" });
    const notice = screen.getByTestId("call-device-notice");
    expect(notice).toHaveTextContent(WEBCAM);
    expect(isolated(notice, WEBCAM)).toBe(true);
  });

  it("the device notice, word for word", () => {
    renderApp(call({ devices: devices({ kind: "videoinput", type: "lost", name: WEBCAM }) }), { language: "ar" });
    expect(screen.getByTestId("call-device-notice")).toHaveTextContent(`تم فصل ${WEBCAM}. يُستخدم الجهاز الافتراضي.`);
  });

  it.each([[1, "عنصر واحد محفوظ لـ Ana (2) · 1.5 ميغابايت من 64 ميغابايت"], [3, "3 عناصر محفوظة لـ Ana (2) · 1.5 ميغابايت من 64 ميغابايت"]])("the chat's held line (%i held)", (outstanding, text) => {
    const hold: PeerHoldState = { enabled: true, peerAllows: true, storage: true, canHold: true, outstanding, bytes: 1.5 * 1024 * 1024, maxBytes: 64 * 1024 * 1024, maxItems: 64, ttlMs: 7 * 86_400_000, refused: 0 };
    renderApp(<ChatHoldLine hold={hold} name="Ana (2)" />, { language: "ar" });
    const line = screen.getByTestId("hold-indicator");
    expect(line).toHaveTextContent(text);
    expect(isolated(line, "Ana (2)")).toBe(true);
  });
});
