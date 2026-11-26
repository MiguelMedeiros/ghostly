// A contact's proof expires (or enters its last days) by the clock alone: the engine's view of it stays `verified`
// and sends nothing then. Its marks and the face chosen from it still change at that time, from one timer for every
// reader, which waits in steps for a time further off than setTimeout can and looks again when the page is back.
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicProfileView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ContactMarks, IdentityStack } from "../../components/identities/ContactMarks";
import { setFaceChoice, useContactFace, useContactFaces } from "../../components/identities/contactFace";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, receivedView } from "./views";

// covers: proofs.badges, proofs.contact-face

const PEER = "p".repeat(52);
const PUBKY_KEY = "y".repeat(52);
const MAX_WAIT = 2 ** 31 - 1;
const profile: PublicProfileView = { found: true, name: "Pubky Name", hosts: ["nexus.pubky.app"], fetchedAt: now() - 3600 };
const pubky = (patch: Partial<ReceivedIdentityView> = {}) => receivedView({
  id: "pubky-1", provider: "pubky", subject: PUBKY_KEY, verified: { subject: PUBKY_KEY, source: "File on the homeserver" }, publicProfile: profile, ...patch,
});
const keyOf = (i: number) => `k${i}`.padEnd(52, "x");
const withReceived = (received: ReceivedIdentityView[], peerKey = PEER, id = "link-1") => linkView({ id, peerPubKeyZ32: peerKey, identities: identitiesView({ received }) });

function Face() { return <p data-testid="face">{useContactFace(PEER)?.name ?? "none"}</p>; }
function Faces() { return <p data-testid="faces">{useContactFaces()(PEER)?.name ?? "none"}</p>; }
const mark = () => screen.getByTestId("chat-identity-badge");
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("a contact's proof at its expiry, with nothing new from the engine", () => {
  // On a whole second, as the proofs' times are: each test's times then fall where it says.
  beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-11-26T12:00:00Z") }); });
  afterEach(() => { vi.useRealTimers(); });

  it("turns the header's mark expired and drops the face chosen from it", () => {
    // The proof as the issue found it: a minute left (so in its last days), chosen as the contact's face.
    setFaceChoice(PEER, { provider: "pubky", subject: PUBKY_KEY });
    const { engine } = renderApp(<><IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} /><Face /><Faces /></>);
    act(() => engine.update({ links: [withReceived([pubky({ expiresAt: now() + 60 })]), withReceived([], keyOf(1), "link-2")] }));
    expect(mark()).toHaveAttribute("data-state", "expiring");
    expect(screen.getByTestId("face")).toHaveTextContent("Pubky Name");
    expect(screen.getByTestId("faces")).toHaveTextContent("Pubky Name");

    advance(120_000);
    expect(mark()).toHaveAttribute("data-state", "expired");
    expect(screen.getByTestId("face")).toHaveTextContent("none");
    expect(screen.getByTestId("faces")).toHaveTextContent("none");
    // Nothing is left to wait for.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns a mark expiring when the proof enters its last week, then expired at its end", () => {
    const { engine } = renderApp(<IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} />);
    // A 37-day proof is expiring in its last 7 days: those start in a minute.
    act(() => engine.update({ links: [withReceived([receivedView({ verifiedAt: now() - 30 * DAY, expiresAt: now() + 7 * DAY + 60 })])] }));
    expect(mark()).toHaveAttribute("data-state", "verified");
    advance(59_000);
    expect(mark()).toHaveAttribute("data-state", "verified");
    advance(2_000);
    expect(mark()).toHaveAttribute("data-state", "expiring");
    advance(7 * DAY * 1000);
    expect(mark()).toHaveAttribute("data-state", "expired");
  });

  it("waits for a proof that expires in 400 days in steps setTimeout can take, drawing nothing meanwhile", () => {
    let draws = 0;
    const waits = vi.spyOn(globalThis, "setTimeout");
    const { engine } = renderApp(<Profiler id="stack" onRender={() => { draws++; }}><IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} /></Profiler>);
    act(() => engine.update({ links: [withReceived([receivedView({ expiresAt: now() + 400 * DAY })])] }));
    const before = draws, armed = waits.mock.calls.length;
    expect(waits.mock.calls.map(([, ms]) => ms ?? 0).every(ms => ms <= MAX_WAIT)).toBe(true);
    // A wait longer than setTimeout's longest fires at once (and then on every turn); this one is a step of the longest.
    advance(1_000);
    expect(waits.mock.calls.length - armed).toBe(0);
    expect(draws - before).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    advance(MAX_WAIT);
    expect(draws - before).toBe(0);
    expect(mark()).toHaveAttribute("data-state", "verified");
    // Its last week starts at day 393.
    advance(393 * DAY * 1000 - MAX_WAIT);
    expect(mark()).toHaveAttribute("data-state", "expiring");
    advance(7 * DAY * 1000);
    expect(mark()).toHaveAttribute("data-state", "expired");
  });

  it("is worked out again when the page is back after the computer slept past the expiry", () => {
    setFaceChoice(PEER, { provider: "pubky", subject: PUBKY_KEY });
    const { engine } = renderApp(<><IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} /><Face /></>);
    act(() => engine.update({ links: [withReceived([pubky({ expiresAt: now() + 60 })])] }));
    expect(mark()).toHaveAttribute("data-state", "expiring");
    // Asleep: the clock moves on and no timer runs.
    vi.setSystemTime(Date.now() + 3600_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(mark()).toHaveAttribute("data-state", "expired");
    expect(screen.getByTestId("face")).toHaveTextContent("none");
  });

  it("is worked out again on the first engine state after a sleep, when another chat changed", () => {
    const { engine } = renderApp(<IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} />);
    const mine = withReceived([receivedView({ expiresAt: now() + 60 })]);
    act(() => engine.update({ links: [mine, withReceived([], keyOf(1), "link-2")] }));
    vi.setSystemTime(Date.now() + 3600_000);
    // Another contact shared an identity meanwhile.
    act(() => engine.update({ links: [mine, withReceived([receivedView({ id: "r2" })], keyOf(1), "link-2")] }));
    expect(mark()).toHaveAttribute("data-state", "expired");
  });

  it("sets no timer while no contact's proof can expire", () => {
    const { engine } = renderApp(<><IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} /><Face /><ContactMarks peerKey={PEER} /></>);
    act(() => engine.update({ links: [withReceived([receivedView({ status: "revoked" }), receivedView({ id: "r2", status: "expired", expiresAt: now() - DAY })])] }));
    expect(screen.getAllByTestId("chat-identity-badge")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has one timer for a chat list's worth of marks, and every one changes at its time", () => {
    const n = 30;
    const { engine } = renderApp(<>{Array.from({ length: n }, (_, i) => <IdentityStack key={i} peerKey={keyOf(i)} name={`C${i}`} onOpen={() => {}} />)}</>);
    act(() => engine.update({ links: Array.from({ length: n }, (_, i) => withReceived([receivedView({ id: `r${i}`, expiresAt: now() + 60 + i })], keyOf(i), `link-${i}`)) }));
    expect(screen.getAllByTestId("chat-identity-badge").map(m => m.dataset.state)).toEqual(Array(n).fill("expiring"));
    expect(vi.getTimerCount()).toBe(1);
    advance(60_000 + 15_500);
    const states = screen.getAllByTestId("chat-identity-badge").map(m => m.dataset.state);
    expect(states.slice(0, 16)).toEqual(Array(16).fill("expired"));
    expect(states.slice(16)).toEqual(Array(n - 16).fill("expiring"));
    expect(vi.getTimerCount()).toBe(1);
    advance(30_000);
    expect(screen.getAllByTestId("chat-identity-badge").map(m => m.dataset.state)).toEqual(Array(n).fill("expired"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its timer when the last mark goes", () => {
    const { engine, unmount } = renderApp(<><IdentityStack peerKey={PEER} name="Alice" onOpen={() => {}} /><Face /></>);
    act(() => engine.update({ links: [withReceived([receivedView({ expiresAt: now() + 60 })])] }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
