import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatIdentitiesDialog } from "../../components/identities/ChatIdentitiesDialog";
import { date } from "../../lib/identities";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, proofView, receivedView, sharedView } from "./views";


/** A paired chat with Alice, connected now. */
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

function open(state: Parameters<ReturnType<typeof renderApp>["engine"]["update"]>[0]) {
  const onClose = vi.fn();
  const result = renderApp(<ChatIdentitiesDialog peerKey="peer" name="Alice" onClose={onClose} />);
  act(() => result.engine.update(state));
  return { onClose, ...result };
}

const received = () => screen.getAllByTestId("chat-identity-received");
const mine = () => screen.getAllByTestId("chat-identity-mine");

/** A chat → Identities: what the contact shared, and which of mine to show them. */
describe("ChatIdentitiesDialog", () => {
  it("is titled for the contact and says when nothing is shared either way", async () => {
    const { user, onClose } = open({ links: [paired()] });
    expect(screen.getByRole("dialog", { name: "Identities with Alice" })).toBeInTheDocument();
    expect(screen.getByTestId("chat-identities-none")).toHaveTextContent("Nothing shared by this contact.");
    expect(screen.getByTestId("chat-identities-mine")).toHaveTextContent("You have no identities in this profile yet.");
    await user.click(screen.getByRole("button", { name: "Add in Profile" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says identities need a paired chat, and does not offer to share", () => {
    open({ links: [linkView()], identityProofs: [proofView()] });
    expect(screen.getByTestId("chat-identities-mine")).toHaveTextContent("Identities can be shared in paired chats only.");
    expect(screen.getByTestId("chat-identity-share")).toBeDisabled();
  });

  it("says when the contact's app cannot receive identities", () => {
    open({ links: [paired({ identities: identitiesView({ support: false }) })], identityProofs: [proofView()] });
    expect(screen.getByTestId("chat-identities-unsupported")).toHaveTextContent("Alice’s app cannot receive identities yet.");
    expect(screen.getByTestId("chat-identity-share")).toBeDisabled();
  });

  it("still lets the person queue a share while the contact is offline", async () => {
    const { user, engine } = open({ links: [paired({ pairing: undefined, identities: identitiesView({ support: false }) })], identityProofs: [proofView({ id: "p" })] });
    engine.on("shareIdentityProof", () => undefined);
    expect(screen.queryByTestId("chat-identities-unsupported")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("chat-identity-share"));
    expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "p" }]);
  });

  describe("shared by the contact", () => {
    it("lists verified ones first, each with the status this app found", () => {
      open({ links: [paired({ identities: identitiesView({ received: [
        receivedView({ id: "r1", status: "revoked" }),
        receivedView({ id: "r2", status: "unconfirmed", error: "DNS lookup failed" }),
        receivedView({ id: "r3", status: "verified" }),
        // Verified by the engine, but past its expiry now: never shown as verified.
        receivedView({ id: "r4", status: "verified", expiresAt: now() - DAY }),
        receivedView({ id: "r5", status: "withdrawn" }),
        receivedView({ id: "r6", status: "previous-key" }),
      ] }) })] });
      expect(received().map((r) => [r.dataset.status, within(r).getByTestId("chat-identity-received-status").textContent])).toEqual([
        ["verified", "Verified"],
        ["revoked", "Revoked by its owner"],
        ["unconfirmed", "Could not be confirmed"],
        ["expired", "Expired"],
        ["withdrawn", "No longer shared"],
        ["previous-key", "From a previous key"],
      ]);
      expect(received()[2]).toHaveTextContent("DNS lookup failed");
      expect(received()[1]).toHaveTextContent("Its owner removed it from their profile and published a revocation");
    });

    it("says who vouches for an attested identity and that a key proof is the holder's own", () => {
      open({ links: [paired({ identities: identitiesView({ received: [
        receivedView({ id: "r1", provider: "domain" }),
        receivedView({ id: "r2", provider: "oidc", subject: "https://accounts.google.com", verified: { subject: "https://accounts.google.com#42", source: "ID token signed by accounts.google.com", attester: "accounts.google.com" } }),
      ] }) })] });
      const [domain, oidc] = received();
      expect(domain).toHaveTextContent("Their own key");
      expect(domain).toHaveTextContent("Only the holder of this key could have made this proof.");
      expect(oidc).toHaveTextContent("Attested by accounts.google.com");
      expect(oidc).toHaveTextContent("accounts.google.com says this account logged in. That is only as trustworthy as accounts.google.com.");
      expect(within(oidc).getByTestId("chat-identity-received-subject")).toHaveTextContent("https://accounts.google.com");
    });

    it("shows a looked-up name with where it came from", () => {
      open({ links: [paired({ identities: identitiesView({ received: [receivedView({ display: { name: "Alice Liddell", source: "keys.openpgp.org", fetchedAt: now() } })] }) })] });
      expect(received()[0]).toHaveTextContent("Alice Liddell · Domain");
      expect(within(received()[0]).getByTestId("chat-identity-received-name-source")).toHaveTextContent("keys.openpgp.org");
    });

    it("checks again on request, but not what was withdrawn or revoked", async () => {
      const { user, engine } = open({ links: [paired({ identities: identitiesView({ received: [
        receivedView({ id: "r1" }), receivedView({ id: "r2", status: "withdrawn" }), receivedView({ id: "r3", status: "revoked" }),
      ] }) })] });
      engine.on("recheckIdentityProof", () => undefined);
      expect(within(received()[1]).queryByTestId("chat-identity-recheck")).not.toBeInTheDocument();
      expect(within(received()[2]).queryByTestId("chat-identity-recheck")).not.toBeInTheDocument();
      // Domain proofs are re-checked, not only looked up for a revocation.
      expect(received()[0]).toHaveTextContent("“Check again” looks for a revocation by its owner and repeats the check.");
      await user.click(within(received()[0]).getByTestId("chat-identity-recheck"));
      expect(engine.callsTo("recheckIdentityProof")).toEqual([{ linkId: "link-1", id: "r1" }]);
    });

    it("offers a provider's public lookup only for a verified identity", async () => {
      const key = "0123456789ABCDEF0123456789ABCDEF01234567";
      const { user, engine } = open({ links: [paired({ identities: identitiesView({ received: [
        receivedView({ id: "r1", provider: "openpgp", subject: key, verified: { subject: key, source: "OpenPGP signature" } }),
        receivedView({ id: "r2", provider: "openpgp", subject: key, status: "unconfirmed", verified: { subject: key, source: "OpenPGP signature" } }),
      ] }) })] });
      engine.on("lookupIdentityDisplay", () => undefined);
      expect(within(received()[1]).queryByTestId("chat-identity-lookup")).not.toBeInTheDocument();
      await user.click(within(received()[0]).getByRole("button", { name: "Check emails with keys.openpgp.org" }));
      expect(engine.callsTo("lookupIdentityDisplay")).toEqual([{ linkId: "link-1", id: "r1" }]);
    });

    it("shows why a re-check failed", async () => {
      const { user, engine } = open({ links: [paired({ identities: identitiesView({ received: [receivedView()] }) })] });
      engine.on("recheckIdentityProof", () => { throw new Error("Offline: this identity cannot be checked now"); });
      await user.click(screen.getByTestId("chat-identity-recheck"));
      expect(await screen.findByTestId("chat-identities-error")).toHaveTextContent("Offline: this identity cannot be checked now");
    });

    it("shows the engine's error for the chat", () => {
      open({ links: [paired({ identities: identitiesView({ error: "Alice sent a proof this app could not read" }) })] });
      expect(screen.getByTestId("chat-identities-error")).toHaveTextContent("Alice sent a proof this app could not read");
    });
  });

  describe("mine, for this contact", () => {
    it.each([
      ["queued", "Shared when you next connect", true],
      ["pending", "Waiting for your contact", true],
      ["accepted", "Shared · verified by your contact", true],
      ["withdrawal-pending", "Stopping…", false],
      ["withdrawn", "Not shared", false],
    ] as const)("says a %s share is: %s", (status, text, on) => {
      open({ links: [paired({ identities: identitiesView({ shared: [sharedView({ status })] }) })], identityProofs: [proofView()] });
      expect(screen.getByTestId("chat-identity-mine-status")).toHaveTextContent(new RegExp(`^${text}$`));
      expect(screen.queryByRole("button", { name: on ? "Stop sharing" : "Share" })).toBeInTheDocument();
    });

    it("says why the contact did not verify it, and lets the person withdraw it", () => {
      open({ links: [paired({ identities: identitiesView({ shared: [sharedView({ status: "rejected", error: "Record not found" })] }) })], identityProofs: [proofView()] });
      expect(screen.getByTestId("chat-identity-mine-status")).toHaveTextContent("Not verified by your contact: Record not found");
      // Still shared as far as the ledger goes: the way out is to stop sharing it.
      expect(screen.getByTestId("chat-identity-withdraw")).toBeEnabled();
    });

    it("shares and stops sharing through the engine", async () => {
      const { user, engine } = open({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "b" })] }) })],
        identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] });
      engine.on("shareIdentityProof", () => undefined).on("withdrawIdentityProof", () => undefined);
      const [a, b] = mine();
      expect(a).toHaveTextContent("Not shared");
      await user.click(within(a).getByRole("button", { name: "Share" }));
      await user.click(within(b).getByRole("button", { name: "Stop sharing" }));
      expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "a" }]);
      expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "b" }]);
      expect(screen.getByTestId("chat-identities-mine")).toHaveTextContent("Sharing the same identity in several chats lets those contacts know it is you. Stopping tells Alice");
    });

    it("does not share an expired identity", () => {
      const gone = now() - DAY;
      open({ links: [paired()], identityProofs: [proofView({ expiresAt: gone })] });
      expect(screen.getByTestId("chat-identity-mine-status")).toHaveTextContent(`Expired ${date(gone)}`);
      expect(screen.getByTestId("chat-identity-share")).toBeDisabled();
    });

    it("does not share what the contact's app cannot verify", () => {
      open({ links: [paired({ identities: identitiesView({ contactProviders: ["nostr"] }) })], identityProofs: [proofView()] });
      expect(mine()[0]).toHaveTextContent("Alice’s app cannot verify Domain yet.");
      expect(screen.getByTestId("chat-identity-share")).toBeDisabled();
    });

    it("shows why sharing failed", async () => {
      const { user, engine } = open({ links: [paired()], identityProofs: [proofView()] });
      engine.on("shareIdentityProof", () => { throw new Error("Alice is not connected"); });
      await user.click(screen.getByTestId("chat-identity-share"));
      expect(await screen.findByTestId("chat-identities-error")).toHaveTextContent("Alice is not connected");
      expect(screen.getByTestId("chat-identity-share")).toBeEnabled();
    });
  });
});
