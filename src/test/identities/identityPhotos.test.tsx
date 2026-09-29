import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkView, PublicProfileView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { IdentityStack } from "../../components/identities/ContactMarks";
import { IdentityProofsSection } from "../../components/identities/IdentityProofsSection";
import { linkView } from "../fakeEngine";
import { renderApp as render } from "../render";
import { identitiesView, now, proofView, receivedView } from "./views";

// covers: proofs.public-profile.picture, proofs.deck, proofs.badges, proofs.composer

/**
 * A verified identity's profile picture on its card, everywhere cards are (the Identities page, the composer's picker,
 * the contact's panel, the header's marks): the picture in the photo slot and the provider's mark as a badge on its
 * corner; the provider's mark alone without a picture, while loading, and when a rule refused it.
 */
const renderApp = (...args: Parameters<typeof render>) => { const shown = render(...args); document.documentElement.dataset.reduceMotion = "true"; return shown; };
afterEach(() => vi.unstubAllGlobals());

const AVATAR = "data:image/jpeg;base64,/9j/2Q==";
const NOSTR_KEY = "b".repeat(64);
const PUBKY_KEY = "y".repeat(52);
const profile = (patch: Partial<PublicProfileView> = {}): PublicProfileView => ({ found: true, name: "Pat", avatar: AVATAR, hosts: ["nexus.pubky.app"], fetchedAt: now() - 60, ...patch });
const nostrProof = (patch = {}) => proofView({ id: "nostr-1", provider: "nostr", subject: NOSTR_KEY, verified: { subject: NOSTR_KEY, source: "Nostr signature" }, ...patch });
const pubkyReceived = (patch: Partial<ReceivedIdentityView> = {}) => receivedView({ id: "pubky-1", provider: "pubky", subject: PUBKY_KEY, verified: { subject: PUBKY_KEY, source: "File on the homeserver" }, ...patch });
const paired = (received: ReceivedIdentityView[] = [], patch: Partial<LinkView> = {}): LinkView =>
  linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView({ received }), ...patch });

/** A card's photo slot: the picture and its corner badge, or the provider's mark alone. */
function slot(card: HTMLElement) {
  const photo = card.querySelector<HTMLElement>(".id-card-photo")!;
  return {
    img: within(photo).queryByTestId("id-card-photo"),
    badge: within(photo).queryByTestId("id-card-photo-badge"),
    mark: photo.querySelector(":scope > [data-icon]")?.getAttribute("data-icon"),
  };
}

describe("the card's photo slot", () => {
  it("the Identities page: the profile's picture, sized and decoded off the main thread, with the provider's mark on its corner", () => {
    const { engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: profile({ hosts: ["relay.damus.io"] }) })] }));
    const s = slot(screen.getByTestId("identity-proof"));
    expect(s.img).toHaveAttribute("src", AVATAR);
    expect(s.img).toHaveAttribute("decoding", "async");
    expect(s.img).toHaveAttribute("width", "160");
    expect(s.badge!.querySelector("[data-icon]")).toHaveAttribute("data-icon", "nostr");
    expect(s.mark).toBeUndefined();
  });

  it("no picture, still loading, or refused: the provider's mark, and the details say which rule refused it", async () => {
    const { engine, user } = renderApp(<IdentityProofsSection />);
    for (const publicProfile of [undefined, { found: false, hosts: [], fetchedAt: 0, loading: true }, profile({ avatar: undefined })]) {
      act(() => engine.update({ identityProofs: [nostrProof(publicProfile ? { publicProfile } : {})] }));
      const s = slot(screen.getByTestId("identity-proof"));
      expect([s.img, s.badge, s.mark]).toEqual([null, null, "nostr"]);
    }
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: profile({ avatar: undefined, avatarMiss: "it is on tracker.example, a host this app does not load pictures from" }) })] }));
    await user.click(screen.getByTestId("identity-proof"));
    expect(screen.getByTestId("identity-public-profile-details-picture-miss")).toHaveTextContent("The profile’s picture is not shown: it is on tracker.example, a host this app does not load pictures from.");
    // An expired proof's card never wears it, even with a picture kept.
    act(() => engine.update({ identityProofs: [nostrProof({ publicProfile: profile(), expiresAt: now() - 1 })] }));
    expect(slot(screen.getAllByTestId("identity-proof")[0]).img).toBeNull();
  });

  it("the composer's picker: one's own identity wears its picture", () => {
    const { engine } = renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={() => {}} />);
    act(() => engine.update({ links: [paired()], identityProofs: [nostrProof({ publicProfile: profile() })] }));
    const card = screen.getAllByTestId("composer-identity").find(c => c.querySelector("[data-profile=found]"))!;
    const s = slot(card);
    expect(s.img).toHaveAttribute("src", AVATAR);
    expect(s.badge!.querySelector("[data-icon]")).toHaveAttribute("data-icon", "nostr");
  });

  it("a contact's panel: their verified identity wears its picture; a revoked one keeps the mark", () => {
    const { engine } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />);
    act(() => engine.update({ links: [paired([pubkyReceived({ publicProfile: profile() })])] }));
    const s = slot(screen.getByTestId("chat-identity-received"));
    expect(s.img).toHaveAttribute("src", AVATAR);
    expect(s.badge!.querySelector("[data-icon]")).toHaveAttribute("data-icon", "pubky");
    act(() => engine.update({ links: [paired([pubkyReceived({ status: "revoked", publicProfile: profile() })])] }));
    expect(slot(screen.getByTestId("chat-identity-received")).img).toBeNull();
  });
});

describe("the header's marks", () => {
  it("a verified identity with a picture: the picture fills the mark, the provider's mark on its corner", () => {
    const { engine } = renderApp(<IdentityStack peerKey="peer" name="Alice" onOpen={() => {}} />);
    act(() => engine.update({ links: [paired([pubkyReceived({ publicProfile: profile() })])] }));
    const mark = screen.getByTestId("chat-identity-badge");
    expect(mark).toHaveAttribute("data-photo");
    expect(within(mark).getByTestId("badge-mark-photo")).toHaveAttribute("src", AVATAR);
    expect(mark.querySelector(".badge-mark-corner svg")).not.toBeNull();
  });

  it("without a picture, or once the proof stops vouching for it, the provider's mark as before", () => {
    const { engine } = renderApp(<IdentityStack peerKey="peer" name="Alice" onOpen={() => {}} />);
    for (const r of [pubkyReceived(), pubkyReceived({ publicProfile: profile({ avatar: undefined }) }), pubkyReceived({ publicProfile: profile(), expiresAt: now() - 1 })]) {
      act(() => engine.update({ links: [paired([r])] }));
      const mark = screen.getByTestId("chat-identity-badge");
      expect(mark).not.toHaveAttribute("data-photo");
      expect(within(mark).queryByTestId("badge-mark-photo")).toBeNull();
    }
  });
});
