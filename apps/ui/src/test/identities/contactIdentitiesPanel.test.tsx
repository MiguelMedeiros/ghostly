import { act, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, receivedView } from "./views";

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
        const card = await turnOver(user, i);
        expect(within(card).queryByTestId("chat-identity-recheck")).not.toBeInTheDocument();
        // Nor a word about a Check again that is not there.
        expect(card).not.toHaveTextContent("Check again");
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

    it("in Arabic, keeps how it was checked, who attests it and where its name came from each in its own direction", async () => {
      // English in an Arabic card, isolated: the bracket and the period stay with the words they belong to.
      const onClose = vi.fn();
      const { user, engine } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={onClose} />, { language: "ar" });
      document.documentElement.dataset.reduceMotion = "true";
      act(() => engine.update(withReceived([receivedView({ provider: "oidc", subject: "https://accounts.google.com",
        display: { name: "Alice Liddell", source: "keys.openpgp.org (WKD)", fetchedAt: now() },
        verified: { subject: "https://accounts.google.com#42", source: "Nostr signature (NIP-01, BIP-340)", attester: "accounts.google.com (OIDC)" } })])));
      const card = await turnOver(user, 0);
      const isolated = (el: Element) => [...el.querySelectorAll("bdi")].map(bdi => bdi.textContent);
      const facts = card.querySelector("dl")!;
      expect(isolated(facts)).toEqual(["accounts.google.com (OIDC)", "accounts.google.com (OIDC)", "Nostr signature (NIP-01, BIP-340)"]);
      expect(facts.textContent).not.toContain("{{");
      expect(isolated(within(card).getByTestId("chat-identity-received-name-source"))).toEqual(["keys.openpgp.org (WKD)"]);
    });
  });

  /** The panel with the chat's message field before it, as Chat.tsx lays them out. */
  function besideChat(docked: boolean) {
    // contact-panel.css hides the backdrop where the panel docks beside the chat (the tests load no stylesheets).
    const style = document.createElement("style");
    style.textContent = docked ? ".contact-panel-backdrop{display:none}" : "";
    document.head.append(style);
    onTestFinished(() => style.remove());
    const onClose = vi.fn();
    const result = renderApp(<div className="chat-pane">
      <textarea data-testid="composer" aria-label="Message" />
      <ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={onClose} />
    </div>);
    document.documentElement.dataset.reduceMotion = "true";
    act(() => result.engine.update(withReceived([receivedView({ id: "r1" })])));
    return { onClose, ...result };
  }

  it("docked beside the chat, is a region of the page: Tab goes on to the chat, F6 between them, Escape closes it from inside only", async () => {
    const { user, onClose } = besideChat(true);
    const panel = screen.getByRole("complementary", { name: "Identities with Alice" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(panel).toHaveFocus();
    const composer = screen.getByTestId("composer");
    for (let i = 0; i < 14 && document.activeElement !== composer; i++) await user.tab();
    expect(composer).toHaveFocus();
    // Escape in the message field is the field's: the panel stays.
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{F6}");
    expect(panel).toHaveFocus();
    await user.keyboard("{F6}");
    expect(composer).toHaveFocus();
    await user.keyboard("{F6}");
    await user.tab();
    expect(screen.getByTestId("chat-identities-close")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("over the chat (its backdrop shown), is a modal dialog: Tab stays in it", async () => {
    const { user } = besideChat(false);
    const panel = screen.getByRole("dialog", { name: "Identities with Alice" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    for (let i = 0; i < 14; i++) { await user.tab(); expect(panel).toContainElement(document.activeElement as HTMLElement); }
  });
});

