import { act, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, proofView, receivedView, sharedView } from "./views";

// covers: proofs.badges, proofs.recheck, proofs.expiry, proofs.unverifiable, proofs.public-activity

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** A paired chat with Alice, connected now. */
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

function open(state: Parameters<ReturnType<typeof renderApp>["engine"]["update"]>[0]) {
  const onClose = vi.fn();
  const result = renderApp(<>
    <ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={onClose} />
    <Routes><Route path="*" element={<Where />} /></Routes>
  </>);
  // No swing as a card comes up (set after the render, which applies the profile's own setting as it mounts).
  document.documentElement.dataset.reduceMotion = "true";
  act(() => result.engine.update(state));
  return { onClose, ...result };
}

const theirs = () => within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received");
const back = () => screen.getByTestId("chat-identity-back");
/** Turns the contact's card over, as a click on it does. */
async function turnOver(user: ReturnType<typeof renderApp>["user"], i: number) {
  await user.click(theirs()[i]);
  return back();
}
const withReceived = (received: ReceivedIdentityView[]) => ({ links: [paired({ identities: identitiesView({ received }) })] });

/** A contact's identities, in a panel beside the chat: their ID cards, and the chosen one's public data. */
describe("ContactIdentitiesPanel", () => {
  it("is titled for the contact, closes, and says when nothing is shared", async () => {
    const { user, onClose } = open({ links: [paired()] });
    expect(screen.getByRole("dialog", { name: "Identities with Alice" })).toBeInTheDocument();
    expect(screen.getByTestId("chat-identities-none")).toHaveTextContent("Nothing else shared by Alice yet.");
    // Their Ghostly card alone, and nothing of mine: mine are shared from the composer.
    expect(screen.queryAllByTestId("chat-identity-received")).toHaveLength(0);
    expect(within(screen.getByTestId("chat-identities-received")).getByTestId("chat-identity-ghostly")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("chat-identities-mine")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-identity-ghostly")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-identities-share-yours")).toHaveTextContent("Share yours from the + in the chat.");
    await user.click(screen.getByTestId("chat-identities-close"));
    expect(onClose).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });


  describe("shared by the contact", () => {
    it("is a deck of their ID cards, verified first then in the header's order, each with the status this app found", () => {
      open(withReceived([
        receivedView({ id: "r1", status: "revoked" }),
        receivedView({ id: "r2", provider: "bitcoin", subject: "bc1q", verified: { subject: "bc1q", source: "BIP-322" } }),
        receivedView({ id: "r3", status: "unconfirmed", error: "DNS lookup failed" }),
        // Verified by the engine, but past its expiry now: never shown as verified.
        receivedView({ id: "r4", status: "verified", expiresAt: now() - DAY }),
        receivedView({ id: "r5", status: "withdrawn" }),
        receivedView({ id: "r6", status: "previous-key" }),
        receivedView({ id: "r7", provider: "domain", subject: "example.org" }),
      ]));
      expect(screen.getByRole("radiogroup", { name: "Identities shared by Alice" })).toBeInTheDocument();
      const faces = theirs().map(card => card.querySelector<HTMLElement>("[data-deck=face]")!);
      expect(faces.map(f => [f.dataset.status, f.querySelector(".id-card-status")!.textContent])).toEqual([
        ["verified", "Verified"],
        ["verified", "Verified"],
        ["revoked", "Revoked"],
        ["failed", "Check failed"],
        ["expired", "Expired"],
        ["withdrawn", "No longer shared"],
        ["withdrawn", "From a previous key"],
      ]);
    });

    it("turns a card over to how it was checked, and back", async () => {
      const { user } = open(withReceived([receivedView({ id: "r1", status: "unconfirmed", error: "DNS lookup failed" })]));
      expect(screen.queryByTestId("chat-identity-back")).not.toBeInTheDocument();
      const card = await turnOver(user, 0);
      expect(card).toHaveAttribute("data-status", "failed");
      expect(within(card).getByTestId("chat-identity-received-status")).toHaveTextContent("Check failed: could not be confirmed (DNS lookup failed)");
      expect(card).toHaveTextContent("DNS TXT record for example.org");
      expect(within(card).getByTestId("chat-identity-checked")).toHaveTextContent(/^On this device /);
      expect(card).toHaveTextContent("Valid until");
      await user.click(within(card).getByTestId("chat-identity-cards"));
      await vi.waitFor(() => expect(screen.queryByTestId("chat-identity-back")).not.toBeInTheDocument());
      expect(theirs()).toHaveLength(1);
    });

    it("says who vouches for an attested identity and that a key proof is the holder's own", async () => {
      const { user } = open(withReceived([
        receivedView({ id: "r1", provider: "domain" }),
        receivedView({ id: "r2", provider: "oidc", subject: "https://accounts.google.com", verified: { subject: "https://accounts.google.com#42", source: "ID token signed by accounts.google.com", attester: "accounts.google.com" } }),
      ]));
      expect(await turnOver(user, 0)).toHaveTextContent("Only the holder of this key could have made this proof.");
      expect(back()).toHaveTextContent("Their own key");
      await user.click(screen.getByTestId("chat-identity-cards"));
      await vi.waitFor(() => expect(screen.queryByTestId("chat-identity-back")).not.toBeInTheDocument());
      const oidc = await turnOver(user, 1);
      expect(oidc).toHaveTextContent("Attested by accounts.google.com");
      expect(oidc).toHaveTextContent("accounts.google.com says this account logged in: only as trustworthy as accounts.google.com.");
    });

    it("shows a looked-up name on the card, and on its back where the name came from", async () => {
      const { user } = open(withReceived([receivedView({ display: { name: "Alice Liddell", source: "keys.openpgp.org", fetchedAt: now() } })]));
      expect(theirs()[0]).toHaveTextContent("Alice Liddell");
      const card = await turnOver(user, 0);
      expect(card).toHaveTextContent("Domain · Alice Liddell");
      expect(within(card).getByTestId("chat-identity-received-name-source")).toHaveTextContent("Name: keys.openpgp.org");
    });

    it("checks again on request, but not what was withdrawn or revoked", async () => {
      const { user, engine } = open(withReceived([receivedView({ id: "r1" }), receivedView({ id: "r2", status: "withdrawn" }), receivedView({ id: "r3", status: "revoked" })]));
      engine.on("recheckIdentityProof", () => undefined);
      // Domain proofs are re-checked, not only looked up for a revocation.
      expect(await turnOver(user, 0)).toHaveTextContent("Check again looks for a revocation by its owner and repeats the check.");
      await user.click(screen.getByTestId("chat-identity-recheck"));
      expect(engine.callsTo("recheckIdentityProof")).toEqual([{ linkId: "link-1", id: "r1" }]);
      for (const i of [1, 2]) {
        await user.click(screen.getByTestId("chat-identity-cards"));
        await vi.waitFor(() => expect(screen.queryByTestId("chat-identity-back")).not.toBeInTheDocument());
        expect(within(await turnOver(user, i)).queryByTestId("chat-identity-recheck")).not.toBeInTheDocument();
      }
    });

    it("offers a provider's public lookup only for a verified identity", async () => {
      const key = "0123456789ABCDEF0123456789ABCDEF01234567";
      const { user, engine } = open(withReceived([
        receivedView({ id: "r1", provider: "openpgp", subject: key, verified: { subject: key, source: "OpenPGP signature" } }),
        receivedView({ id: "r2", provider: "openpgp", subject: key, status: "unconfirmed", verified: { subject: key, source: "OpenPGP signature" } }),
      ]));
      engine.on("lookupIdentityDisplay", () => undefined);
      await turnOver(user, 0);
      await user.click(within(back()).getByRole("button", { name: "Check emails with keys.openpgp.org" }));
      expect(engine.callsTo("lookupIdentityDisplay")).toEqual([{ linkId: "link-1", id: "r1" }]);
      await user.click(screen.getByTestId("chat-identity-cards"));
      await vi.waitFor(() => expect(screen.queryByTestId("chat-identity-back")).not.toBeInTheDocument());
      expect(within(await turnOver(user, 1)).queryByTestId("chat-identity-lookup")).not.toBeInTheDocument();
    });

    it("shows why a re-check failed", async () => {
      const { user, engine } = open(withReceived([receivedView()]));
      engine.on("recheckIdentityProof", () => { throw new Error("Offline: this identity cannot be checked now"); });
      await turnOver(user, 0);
      await user.click(screen.getByTestId("chat-identity-recheck"));
      expect(await screen.findByTestId("chat-identities-error")).toHaveTextContent("Offline: this identity cannot be checked now");
    });

    it("holds the Nostr key's profile, follows and notes on the Nostr card's back, with a short relay note", async () => {
      const npub = "npub1example";
      const { user } = open({ links: [paired({ identities: identitiesView({ received: [receivedView({ provider: "nostr", subject: npub, verified: { subject: npub, source: "Nostr signature" } })] }), nostr: [{ subject: npub } as NonNullable<LinkView["nostr"]>[number]] })] });
      const card = await turnOver(user, 0);
      for (const id of ["nostr-load-profile", "nostr-load-follows", "nostr-load-notes"]) expect(within(card).getByTestId(id)).toBeInTheDocument();
      expect(within(card).getByTestId("nostr-contact-note")).toHaveTextContent(/^Loading asks your relays \(.*\), which learn your IP address and this key\./);
    });
  });

  describe("the chosen card's public data", () => {
    const PUBKY = "y".repeat(52);
    const pubky = (patch: Partial<ReceivedIdentityView> = {}) => receivedView({ id: "pubky-1", provider: "pubky", subject: PUBKY, verified: { subject: PUBKY, source: "File on the homeserver" }, ...patch });

    it("comes up on their first shared card, and shows its profile and posts under the deck", async () => {
      const { engine } = open(withReceived([pubky({ publicProfile: { found: true, name: "Pat", hosts: ["nexus.pubky.app"], fetchedAt: now() } })]));
      engine.on("loadPublicPosts", () => ({ posts: [{ id: "p1", createdAt: now() - 60, text: "Hello", images: [] }], more: false, hosts: ["nexus.pubky.app"], fetchedAt: now() }));
      engine.on("loadPublicGraph", () => null);
      expect(theirs()[0]).toHaveAttribute("aria-checked", "true");
      const block = await screen.findByTestId("contact-activity");
      expect(block).toHaveAttribute("data-provider", "pubky");
      expect(within(block).getByTestId("contact-activity-name")).toHaveTextContent("Pat");
      expect(await within(block).findByTestId("contact-activity-post")).toHaveTextContent("Hello");
      expect(engine.callsTo("loadPublicPosts")).toEqual([{ provider: "pubky", subject: PUBKY, force: false }]);
    });

    it("nothing for the Ghostly card, an identity without posts, or one no longer verified; nothing asked", async () => {
      const { engine } = open(withReceived([receivedView(), pubky({ status: "revoked" })]));
      await act(async () => {});
      expect(screen.queryByTestId("contact-activity")).not.toBeInTheDocument();
      expect(engine.callsTo("loadPublicPosts")).toEqual([]);
      expect(engine.callsTo("loadPublicGraph")).toEqual([]);
    });

    it("the panel closed asks nothing", () => {
      renderApp(<p>no panel</p>).engine.update(withReceived([pubky()]));
      expect(screen.queryByTestId("contact-activity")).not.toBeInTheDocument();
    });

    it("shows the engine's error for the chat", () => {
      open({ links: [paired({ identities: identitiesView({ error: "Alice sent a proof this app could not read" }) })] });
      expect(screen.getByTestId("chat-identities-link-error")).toHaveTextContent("Alice sent a proof this app could not read");
    });
  });
});
