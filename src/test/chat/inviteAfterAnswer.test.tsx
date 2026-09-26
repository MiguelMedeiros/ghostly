import { act, screen } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { INVITE_LEAVE_MS, InviteCard } from "../../components/InviteCard";
import { PairingScene } from "../../components/pairing/PairingScene";
import { usePairingProgress } from "../../hooks/usePairingProgress";
import { contactArrived, type PairingProgress } from "../../lib/pairingProgress";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.pairing-progress, invite.code

const { inviteCode } = createChatInvite();

/** Chat.tsx's inviter side: the scene, and the invite card while the contact has not arrived with it. */
function Inviter() {
  const p = usePairingProgress("peer", { inviter: true, enabled: true, createdAt: Date.now() });
  return <>
    {p.scene && p.progress && <PairingScene progress={p.progress} contact="Alice" retry={() => void p.retry()} retrying={p.retrying} retryError={p.retryError} />}
    <InviteCard code={inviteCode} shown={!contactArrived(p.progress)} />
  </>;
}

type Pairing = NonNullable<LinkView["pairing"]>;
const published = { dataLink: "idle", peerOnline: false, status: "online", pairing: { status: "connecting" } as Pairing } as Partial<LinkView>;
/** The engine's own report of the inviter's pairing. */
const report = (stage: PairingProgress["stage"], patch: Partial<PairingProgress> = {}) =>
  ({ ...published, pairingProgress: { role: "inviter", stage, since: Date.now(), startedAt: Date.now(), attempt: 1, ...patch } } as Partial<LinkView>);

function show(link: Partial<LinkView>, engine: ReturnType<typeof renderApp>["engine"]) {
  act(() => engine.update({ links: [linkView({ createdAt: Date.now(), ...link })] }));
}
const card = () => screen.queryByTestId("invite-card");
const stage = () => screen.getByTestId("pairing-scene").getAttribute("data-stage");
/** The card's way out, to its end. */
function leave() { act(() => { vi.advanceTimersByTime(INVITE_LEAVE_MS); }); }

afterEach(() => { vi.useRealTimers(); delete document.documentElement.dataset.reduceMotion; });

describe("the inviter's invite card, once the contact answers", () => {
  it("is shown while the inviter waits for someone to open the invite", () => {
    const { engine } = renderApp(<Inviter />);
    show(report("waiting"), engine);
    expect(stage()).toBe("waiting");
    expect(card()).toBeVisible();
    expect(card()).not.toHaveAttribute("data-leaving");
  });

  it("goes, with its animation, once the contact's packet is seen; the scene stays", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine } = renderApp(<Inviter />);
    show(report("waiting"), engine);
    show(report("waiting", { peerSeen: true }), engine);
    // On its way out it is out of reach: not read, not clicked, not tabbed to.
    expect(card()).toHaveAttribute("data-leaving");
    expect(card()).toHaveAttribute("aria-hidden", "true");
    expect(card()).toHaveAttribute("inert");
    leave();
    expect(card()).toBeNull();
    expect(stage()).toBe("waiting");
  });

  it.each<PairingProgress["stage"]>(["answering", "connecting", "on-dht"])("is gone at %s", (at) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine } = renderApp(<Inviter />);
    show(report("waiting"), engine);
    show(report(at, at === "on-dht" ? { reason: "waiting", retryable: true } : {}), engine);
    leave();
    expect(card()).toBeNull();
    // On the DHT the chat itself takes over from the scene (WISP 400); up to there, the scene stays.
    if (at !== "on-dht") expect(stage()).toBe(at);
  });

  it("is gone when live, and does not come back once the connected moment is over", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engine } = renderApp(<Inviter />);
    show(report("waiting"), engine);
    show(report("live"), engine);
    leave();
    expect(card()).toBeNull();
    expect(stage()).toBe("live");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByTestId("pairing-scene")).toBeNull();
    expect(card()).toBeNull();
  });

  it("stays gone when an attempt fails after the contact was seen: the contact still has the invite", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine } = renderApp(<Inviter />);
    show(report("answering", { peerSeen: true }), engine);
    leave();
    // The engine's tracker goes back to waiting between attempts and keeps `peerSeen`.
    show(report("waiting", { peerSeen: true, attempt: 2, detail: "The offer was not answered in time; trying again." }), engine);
    expect(stage()).toBe("waiting");
    expect(card()).toBeNull();
  });

  it("comes back when the state goes back to nobody there", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine } = renderApp(<Inviter />);
    // An engine that reports no progress: the stage is read off the link, and the contact's packet can go stale.
    show(published, engine);
    expect(card()).toBeVisible();
    show({ ...published, peerOnline: true }, engine);
    expect(stage()).toBe("answering");
    leave();
    expect(card()).toBeNull();
    show(published, engine);
    expect(stage()).toBe("waiting");
    expect(card()).toBeVisible();
    // It fades back in; the first card never did.
    expect(card()).toHaveAttribute("data-returning");
    expect(card()).not.toHaveAttribute("aria-hidden");
  });

  it("goes at once with reduced motion", () => {
    const { engine } = renderApp(<Inviter />);
    // The app's setting, set after the provider wrote its own.
    document.documentElement.dataset.reduceMotion = "true";
    show(report("waiting"), engine);
    expect(card()).toBeVisible();
    show(report("answering"), engine);
    expect(card()).toBeNull();
  });
});

describe("contactArrived", () => {
  const at = (stage: PairingProgress["stage"], peerSeen?: boolean) => contactArrived({ stage, peerSeen });
  it("is the contact seen, or any stage past the inviter's wait", () => {
    expect(contactArrived(null)).toBe(false);
    expect(at("publishing")).toBe(false);
    expect(at("waiting")).toBe(false);
    expect(at("failed")).toBe(false);
    expect(at("waiting", true)).toBe(true);
    expect(at("failed", true)).toBe(true);
    for (const stage of ["answering", "connecting", "live", "on-dht"] as const) expect(at(stage)).toBe(true);
  });
});
