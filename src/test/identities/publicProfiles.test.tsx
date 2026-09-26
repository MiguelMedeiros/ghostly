import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkView, PublicProfileView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { IdentityStack } from "../../components/identities/ContactMarks";
import { IdentityProofsSection } from "../../components/identities/IdentityProofsSection";
import { idCard, receivedIdCard } from "../../components/identities/idCard";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { linkView } from "../fakeEngine";
import { renderApp as render } from "../render";
import { DAY, identitiesView, now, proofView, receivedView } from "./views";

// covers: proofs.public-profile, proofs.public-profile.setting, proofs.deck, proofs.badges

const renderApp = (...args: Parameters<typeof render>) => { const shown = render(...args); document.documentElement.dataset.reduceMotion = "true"; return shown; };

const AVATAR = "data:image/jpeg;base64,/9j/2Q==";
const NOSTR_KEY = "a".repeat(64);
const PUBKY_KEY = "y".repeat(52);
const profile = (patch: Partial<PublicProfileView> = {}): PublicProfileView => ({
  found: true, name: "Alice Liddell", handle: "alice", about: "Down the rabbit hole", avatar: AVATAR, following: 87,
  hosts: ["relay.damus.io", "nos.lol"], fetchedAt: now() - 3600, ...patch,
});
const nostrProof = (patch = {}) => proofView({ id: "nostr-1", provider: "nostr", subject: NOSTR_KEY, verified: { subject: NOSTR_KEY, source: "Nostr signature" }, ...patch });
const pubkyReceived = (patch: Partial<ReceivedIdentityView> = {}) => receivedView({
  id: "pubky-1", provider: "pubky", subject: PUBKY_KEY, verified: { subject: PUBKY_KEY, source: "File on the homeserver" }, ...patch,
});

/** IntersectionObserver as a browser has it for a card on screen: it reports the card visible at once. */
function cardsOnScreen() {
  const observed = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private fire: IntersectionObserverCallback) {}
    observe(el: Element) { observed(el); queueMicrotask(() => this.fire([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
    disconnect() {}
  });
  return observed;
}
afterEach(() => vi.unstubAllGlobals());

describe("idCard with a public profile", () => {
  it("wears the profile's picture and name while the proof is current, and asks for it only then", () => {
    const card = idCard(nostrProof({ publicProfile: profile() }));
    expect(card).toMatchObject({ name: "Alice Liddell", photo: AVATAR, lookup: { provider: "nostr", subject: NOSTR_KEY } });
    const expired = idCard(nostrProof({ publicProfile: profile(), expiresAt: now() - DAY }));
    expect(expired.name).toBeUndefined();
    expect(expired.photo).toBeUndefined();
    expect(expired.lookup).toBeUndefined();
    // A provider without public profiles never asks.
    expect(idCard(proofView()).lookup).toBeUndefined();
  });

  it("a profile the network does not have leaves the proof's own name", () => {
    const card = idCard(nostrProof({ verified: { subject: NOSTR_KEY, source: "s", display: { name: "@from-proof", source: "x", fetchedAt: 1 } }, publicProfile: profile({ found: false, name: undefined, avatar: undefined }) }));
    expect(card.name).toBe("@from-proof");
  });

  it("a contact's revoked, withdrawn or expired identity never shows its profile", () => {
    for (const status of ["revoked", "withdrawn", "previous-key"] as const) {
      const card = receivedIdCard(pubkyReceived({ status, publicProfile: profile() }));
      expect([card.name, card.photo, card.lookup]).toEqual([undefined, undefined, undefined]);
    }
    expect(receivedIdCard(pubkyReceived({ publicProfile: profile(), expiresAt: now() - 1 })).lookup).toBeUndefined();
    expect(receivedIdCard(pubkyReceived({ publicProfile: profile() }))).toMatchObject({ name: "Alice Liddell", photo: AVATAR });
  });
});

describe("the Identities page's cards", () => {
  it("a card on screen asks for its profile; its details show name, handle, bio, counts and where it came from", async () => {
    cardsOnScreen();
    const { engine, user } = renderApp(<IdentityProofsSection />);
    engine.on("loadPublicProfile", () => undefined);
    act(() => engine.update({ identityProofs: [nostrProof(), proofView({ id: "domain-1" })] }));
    await vi.waitFor(() => expect(engine.callsTo("loadPublicProfile")).toEqual([{ provider: "nostr", subject: NOSTR_KEY }]));
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: profile({ followers: 1204 }) }), proofView({ id: "domain-1" })] }));
    const nostrCard = screen.getAllByTestId("identity-proof")[0];
    expect(within(nostrCard).getByTestId("id-card-name")).toHaveTextContent("Alice Liddell");
    expect(nostrCard.querySelector(".id-card-photo img")).toHaveAttribute("src", AVATAR);
    await user.click(nostrCard);
    const details = screen.getByTestId("identity-public-profile-details");
    expect(within(details).getByTestId("identity-public-profile-details-name")).toHaveTextContent("Alice Liddell");
    expect(within(details).getByTestId("identity-public-profile-details-handle")).toHaveTextContent("alice");
    expect(within(details).getByTestId("identity-public-profile-details-about")).toHaveTextContent("Down the rabbit hole");
    expect(within(details).getByTestId("identity-public-profile-details-counts")).toHaveTextContent("1,204 followers · 87 following");
    expect(within(details).getByTestId("identity-public-profile-details-source")).toHaveTextContent("Loaded from relay.damus.io and nos.lol");
    expect(details).toHaveTextContent("IP address");
    // The domain's card has no public profile: no details.
    await user.click(screen.getAllByTestId("identity-proof")[1]);
    expect(screen.queryByTestId("identity-public-profile")).not.toBeInTheDocument();
  });

  it("without a profile the card is as before, and says so once asked", async () => {
    const { engine, user } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [nostrProof()] }));
    const card = screen.getByTestId("identity-proof");
    expect(within(card).queryByTestId("id-card-name")).not.toBeInTheDocument();
    await user.click(card);
    expect(screen.queryByTestId("identity-public-profile")).not.toBeInTheDocument();
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: { found: false, hosts: ["relay.damus.io"], fetchedAt: now() - 60 } })] }));
    expect(screen.getByTestId("identity-public-profile-details-none")).toHaveTextContent("No public profile on Nostr");
    expect(screen.getByTestId("identity-public-profile-details-source")).toHaveTextContent("Asked relay.damus.io");
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: { found: false, hosts: [], fetchedAt: 0, loading: true } })] }));
    expect(screen.getByTestId("identity-public-profile-details")).toHaveTextContent("Loading the public profile from your Nostr relays");
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: { found: false, hosts: [], fetchedAt: 0, error: "No relay answered" } })] }));
    expect(screen.getByTestId("identity-public-profile-details-error")).toHaveTextContent("could not be loaded");
  });

  it("an expired proof's card does not ask", async () => {
    cardsOnScreen();
    const { engine } = renderApp(<IdentityProofsSection />);
    engine.on("loadPublicProfile", () => undefined);
    act(() => engine.update({ identityProofs: [nostrProof({ expiresAt: now() - DAY })] }));
    await new Promise(r => setTimeout(r, 20));
    expect(engine.callsTo("loadPublicProfile")).toEqual([]);
  });
});

describe("a contact's cards", () => {
  const paired = (received: ReceivedIdentityView[]): { links: LinkView[] } =>
    ({ links: [linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView({ received }) })] });

  it("the card's back holds the profile: counts, bio and the host it came from", async () => {
    cardsOnScreen();
    const { engine, user } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />);
    engine.on("loadPublicProfile", () => undefined);
    act(() => engine.update(paired([pubkyReceived({ publicProfile: profile({ handle: undefined, followers: 12, following: 7, hosts: ["nexus.pubky.app"] }) })])));
    await vi.waitFor(() => expect(engine.callsTo("loadPublicProfile")).toContainEqual({ provider: "pubky", subject: PUBKY_KEY }));
    const card = screen.getByTestId("chat-identity-received");
    expect(within(card).getByTestId("id-card-name")).toHaveTextContent("Alice Liddell");
    await user.click(card);
    const back = screen.getByTestId("chat-identity-public-profile");
    expect(within(back).getByTestId("chat-identity-public-profile-counts")).toHaveTextContent("12 followers · 7 following");
    expect(within(back).getByTestId("chat-identity-public-profile-source")).toHaveTextContent("Loaded from nexus.pubky.app");
    expect(screen.getByTestId("chat-identity-received-name-source")).toHaveTextContent("their public profile");
  });

  it("a revoked card has no profile on its back", async () => {
    const { engine, user } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />);
    act(() => engine.update(paired([pubkyReceived({ status: "revoked", publicProfile: profile() })])));
    await user.click(screen.getByTestId("chat-identity-received"));
    expect(screen.queryByTestId("chat-identity-public-profile")).not.toBeInTheDocument();
  });

  it("the header mark's tooltip names the profile, and hovering it asks for it", async () => {
    const { engine } = renderApp(<IdentityStack peerKey="peer" name="Alice" onOpen={() => {}} />);
    engine.on("loadPublicProfile", () => undefined);
    act(() => engine.update(paired([pubkyReceived()])));
    fireEvent.pointerOver(screen.getByTestId("chat-identity-badge"), { pointerType: "mouse" });
    await vi.waitFor(() => expect(engine.callsTo("loadPublicProfile")).toEqual([{ provider: "pubky", subject: PUBKY_KEY }]));
    expect(screen.getByTestId("chat-identity-tip")).not.toHaveTextContent("Alice Liddell");
    act(() => engine.update(paired([pubkyReceived({ publicProfile: profile() })])));
    expect(within(screen.getByTestId("chat-identity-tip")).getByTestId("identity-tip-name")).toHaveTextContent("Alice Liddell");
  });
});

describe("Settings → Load public profiles", () => {
  it("is on by default and turns off through the engine's settings", async () => {
    const { engine, user } = renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);
    engine.on("updateSettings", () => undefined);
    const toggle = screen.getByTestId("settings-public-profiles");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    await vi.waitFor(() => expect(engine.callsTo("updateSettings")).toEqual([{ settings: { publicProfiles: false } }]));
    act(() => engine.update({ settings: { publicProfiles: false } }));
    expect(screen.getByTestId("settings-public-profiles")).toHaveAttribute("aria-checked", "false");
  });
});
