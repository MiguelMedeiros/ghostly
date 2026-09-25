import { act, screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { IdentityProofsSection } from "../../components/identities/IdentityProofsSection";
import { date } from "../../lib/identities";
import { linkView } from "../fakeEngine";
import { renderApp as render } from "../render";
import { DAY, identitiesView, now, proofView, sharedView } from "./views";

// covers: proofs.deck, proofs.revoke, proofs.expiry, proofs.withdraw, proofs.ghostly-card, proofs.atproto.remove

/**
 * The swing a card makes as it comes up is skipped with reduced motion: only the choice is tested. Set after the
 * render, which applies the profile's own setting (off) as it mounts.
 */
const renderApp = (...args: Parameters<typeof render>) => { const shown = render(...args); document.documentElement.dataset.reduceMotion = "true"; return shown; };

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

const cards = () => screen.getAllByTestId("identity-proof");
const ghostly = () => screen.getByTestId("identity-ghostly");
const panel = () => screen.getByTestId("identity-panel");
const chosen = () => screen.getAllByRole("tab").filter(t => t.getAttribute("aria-selected") === "true");

/** Identities → Yours: the proofs this profile holds, as a deck of ID cards over the chosen one's panel. */
describe("IdentityProofsSection", () => {
  it("is the Ghostly card and the blank one while there are no proofs, and the blank one adds the first", async () => {
    const { user } = renderApp(<IdentityProofsSection />);
    expect(screen.getByRole("tablist", { name: "Your identities" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map(t => t.dataset.testid)).toEqual(["identity-ghostly", "identity-add"]);
    expect(chosen()).toEqual([ghostly()]);
    expect(screen.getByTestId("identity-add")).toHaveTextContent("Add an identity");
    expect(panel()).toHaveTextContent("what contacts see unless you share another");
    expect(screen.queryByTestId("identity-proof")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("identity-add"));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The panel's button opens it too.
    await user.click(screen.getByTestId("identity-add-open"));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
  });

  it("makes an ID card of each proof, with its provider, subject, category, validity and sharing, and ends with Add identity", () => {
    const valid = now() + 30 * DAY, gone = now() - 2 * DAY;
    const { engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [
      proofView({ id: "a", provider: "domain", subject: "example.com", expiresAt: valid }),
      proofView({ id: "b", provider: "oidc", subject: "https://accounts.google.com", expiresAt: valid, sharedWith: 1,
        verified: { subject: "https://accounts.google.com#1234", source: "ID token signed by accounts.google.com", attester: "accounts.google.com" } }),
      proofView({ id: "c", provider: "ssh-github", subject: "octocat", expiresAt: gone, sharedWith: 3, verified: { subject: "octocat", source: "SSH signature" } }),
    ] }));
    expect(screen.getAllByRole("tab").map(t => t.dataset.testid)).toEqual(["identity-ghostly", "identity-proof", "identity-proof", "identity-proof", "identity-add"]);
    expect(screen.getByTestId("identity-add")).toHaveTextContent("Add another identity");
    const [domain, oidc, github] = cards();
    expect(domain).toHaveTextContent("Domain");
    expect(domain).toHaveTextContent("Your own key");
    expect(domain).toHaveTextContent("Verified");
    expect(within(domain).getByTestId("identity-proof-subject")).toHaveTextContent("example.com");
    expect(domain).toHaveTextContent(`Valid until ${date(valid)}`);
    expect(domain).toHaveTextContent("Not shared");

    expect(oidc).toHaveTextContent("Account at a provider");
    expect(oidc).toHaveTextContent("Attested by accounts.google.com");
    // The full account is kept in the title; the card shows the provider.
    expect(within(oidc).getByTestId("identity-proof-subject")).toHaveAttribute("title", "https://accounts.google.com#1234");
    expect(oidc).toHaveTextContent("Shared in 1 chat");
    expect(oidc).not.toHaveTextContent("Shared in 1 chats");
    // Its ink is its provider's: Google's, not the generic account's.
    expect(oidc).toHaveClass("id-card-oidc-google");

    expect(github).toHaveTextContent("GitHub (SSH key)");
    expect(github).toHaveTextContent(`Expired ${date(gone)}`);
    expect(github).toHaveTextContent("Shared in 3 chats");
    expect(github).toHaveClass("id-card-ssh-github");
  });

  it("names a proof from a provider this app does not know by its id", () => {
    const { engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView({ provider: "some-plugin", subject: "alice", verified: { subject: "alice", source: "Plugin" } })] }));
    expect(cards()[0]).toHaveTextContent("some-plugin");
    expect(cards()[0]).toHaveClass("id-card-key");
  });

  it("shows the chosen card's details below, and follows the choice by click and by key", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net", verified: { subject: "example.net", source: "DNS TXT record" } })] }));
    expect(chosen()).toEqual([cards()[0]]);
    expect(panel()).toHaveAttribute("aria-labelledby", "identity-tab-a");
    expect(within(panel()).getByTestId("identity-panel-subject")).toHaveTextContent("example.com");
    expect(panel()).toHaveTextContent("DNS TXT record. Only the holder of this key could have made this proof.");

    await user.click(cards()[1]);
    expect(chosen()).toEqual([cards()[1]]);
    expect(panel()).toHaveAttribute("aria-labelledby", "identity-tab-b");
    expect(within(panel()).getByTestId("identity-panel-subject")).toHaveTextContent("example.net");

    await user.keyboard("{ArrowRight}");
    expect(chosen()).toEqual([screen.getByTestId("identity-add")]);
    expect(screen.getByTestId("identity-add")).toHaveFocus();
    expect(screen.getByTestId("identity-add-open")).toBeInTheDocument();
    // Selecting the Add card by key does not open the dialog; Enter on it does.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(chosen()).toEqual([ghostly()]);
    await user.click(screen.getByTestId("identity-deck-prev"));
    expect(chosen()).toEqual([screen.getByTestId("identity-add")]);
    screen.getByTestId("identity-add").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
  });

  it("brings up a proof as soon as it is added", () => {
    const { engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView({ id: "a" })] }));
    expect(chosen()).toEqual([cards()[0]]);
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    expect(chosen()).toEqual([cards()[1]]);
  });

  it("says in its panel how to renew a proof in its last days", async () => {
    const t = now();
    const { user, engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView({ id: "soon", issuedAt: t - 28 * DAY, expiresAt: t + 2 * DAY })] }));
    expect(within(cards()[0]).getByTestId("identity-proof-expiring")).toHaveTextContent("Expires in 2 days");
    expect(within(panel()).getByTestId("identity-panel-status")).toHaveTextContent("Expires in 2 days");
    expect(panel()).toHaveTextContent("Add it again to renew it; then remove this one.");
    await user.click(screen.getByTestId("identity-renew"));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
  });

  it("lists the chats it is shared in, and stops sharing it in one", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    engine.on("withdrawIdentityProof", () => undefined);
    act(() => engine.update({
      identityProofs: [proofView({ id: "a", sharedWith: 1 })],
      links: [linkView({ id: "link-1", identities: identitiesView({ shared: [sharedView({ id: "a", status: "accepted" })] }) }), linkView({ id: "link-2", identities: identitiesView({ shared: [sharedView({ id: "a", status: "withdrawn" })] }) })],
    }));
    const sharing = screen.getByTestId("identity-panel-sharing");
    expect(sharing).toHaveTextContent("Shared in 1 chat");
    const chats = within(sharing).getAllByTestId("identity-shared-chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toHaveTextContent("Shared · verified by your contact");
    await user.click(within(chats[0]).getByTestId("identity-shared-stop"));
    expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "a" }]);
  });

  it("asks before removing the chosen card, says what removing does, and asks the engine", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    let finish!: () => void;
    engine.on("removeIdentityProof", () => new Promise<void>(resolve => { finish = resolve; }));
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    await user.click(cards()[1]);
    await user.click(screen.getByTestId("identity-proof-remove"));
    expect(screen.getByText(/a revocation is published/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove and stop sharing" }));
    expect(engine.callsTo("removeIdentityProof")).toEqual([{ id: "b" }]);
    // While the revocation is published, the card says so.
    expect(cards()[1]).toHaveTextContent("Revoking…");
    expect(screen.getByTestId("identity-proof-remove-confirm")).toBeDisabled();
    await act(async () => { finish(); });
    act(() => engine.update({ identityProofs: [proofView({ id: "a" })] }));
    expect(cards()).toHaveLength(1);
    expect(screen.queryByTestId("identity-proof-remove-confirm")).not.toBeInTheDocument();
    // The first card, the Ghostly one, comes up in its place.
    expect(chosen()).toEqual([ghostly()]);
  });

  it("forgets a half-made removal when another card comes up", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    await user.click(screen.getByTestId("identity-proof-remove"));
    await user.click(cards()[1]);
    await user.click(cards()[0]);
    expect(screen.getByTestId("identity-proof-remove")).toBeInTheDocument();
    expect(screen.queryByTestId("identity-proof-remove-confirm")).not.toBeInTheDocument();
  });

  it("keeps the proof when the person says Keep", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView()] }));
    await user.click(screen.getByTestId("identity-proof-remove"));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByTestId("identity-proof-remove")).toBeInTheDocument();
    expect(screen.queryByText(/a revocation is published/)).not.toBeInTheDocument();
    expect(engine.callsTo("removeIdentityProof")).toEqual([]);
  });

  describe("a proof whose provider published something (an AT Protocol record)", () => {
    const atproto = IDENTITY_PROVIDERS.find(p => p.id === "atproto")!;
    const bluesky = () => proofView({ id: "bsky", provider: "atproto", subject: "did:plc:z72i7hdynmk6r22z27h6tvur", key: "k".repeat(52),
      verified: { subject: "did:plc:z72i7hdynmk6r22z27h6tvur", source: "Record signed with the account's key, from pds.example.com", display: { name: "@alice.bsky.social", source: "Handle checked both ways", fetchedAt: now() } } });

    it("deletes the record first, from the click, then removes and revokes", async () => {
      const { user, engine } = renderApp(<IdentityProofsSection />);
      engine.on("removeIdentityProof", () => undefined);
      let finish!: () => void;
      const run = vi.spyOn(atproto.unpublish!, "run").mockImplementation((_proof, ctx) => { ctx.onProgress("Deleting the record on pds.example.com…"); return new Promise<void>(resolve => { finish = resolve; }); });
      act(() => engine.update({ identityProofs: [bluesky()] }));
      await user.click(cards()[0]);
      await user.click(screen.getByTestId("identity-proof-remove"));
      expect(screen.getByText(/Also deletes the record on your server/)).toBeInTheDocument();
      await user.click(screen.getByTestId("identity-proof-remove-confirm"));
      expect(run).toHaveBeenCalledWith({ id: "bsky", subject: "did:plc:z72i7hdynmk6r22z27h6tvur", key: "k".repeat(52) }, expect.anything());
      expect(screen.getByTestId("identity-proof-remove-progress")).toHaveTextContent("Deleting the record on pds.example.com…");
      // The proof stays until its record is gone.
      expect(engine.callsTo("removeIdentityProof")).toEqual([]);
      await act(async () => { finish(); });
      expect(engine.callsTo("removeIdentityProof")).toEqual([{ id: "bsky" }]);
      run.mockRestore();
    });

    it("when the record cannot be deleted, says so and can remove the proof without it", async () => {
      const { user, engine } = renderApp(<IdentityProofsSection />);
      engine.on("removeIdentityProof", () => undefined);
      const run = vi.spyOn(atproto.unpublish!, "run").mockRejectedValue(new Error("You declined on your server."));
      act(() => engine.update({ identityProofs: [bluesky()] }));
      await user.click(cards()[0]);
      await user.click(screen.getByTestId("identity-proof-remove"));
      await user.click(screen.getByTestId("identity-proof-remove-confirm"));
      expect(await screen.findByRole("alert")).toHaveTextContent("You declined on your server.");
      expect(screen.getByText(/contacts still see it revoked/)).toBeInTheDocument();
      expect(engine.callsTo("removeIdentityProof")).toEqual([]);
      await user.click(screen.getByTestId("identity-proof-remove-anyway"));
      expect(engine.callsTo("removeIdentityProof")).toEqual([{ id: "bsky" }]);
      expect(run).toHaveBeenCalledTimes(1);
      run.mockRestore();
    });
  });

  it("shows why a removal failed and keeps asking", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    engine.on("removeIdentityProof", () => { throw new Error("The revocation could not be published"); });
    act(() => engine.update({ identityProofs: [proofView()] }));
    await user.click(screen.getByTestId("identity-proof-remove"));
    await user.click(screen.getByTestId("identity-proof-remove-confirm"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The revocation could not be published");
    expect(screen.getByTestId("identity-proof-remove-confirm")).toBeInTheDocument();
    expect(cards()[0]).toHaveTextContent("Verified");
  });

  describe("the Ghostly card", () => {
    it("comes first with the profile's name and picture, Default, one key per chat and the chats, with and without proofs", () => {
      const { engine } = renderApp(<IdentityProofsSection />);
      act(() => engine.update({ settings: { nick: "Ghost", avatar: "data:image/jpeg;base64,AAAA" }, links: [linkView({ id: "l1", createdAt: Date.UTC(2026, 0, 2) }), linkView({ id: "l2", peerPubKeyZ32: "other", createdAt: Date.UTC(2026, 0, 5) })] }));
      const card = ghostly();
      expect(screen.getAllByRole("tab")[0]).toBe(card);
      expect(chosen()).toEqual([card]);
      expect(card).toHaveClass("id-card-ghostly");
      expect(within(card).getByTestId("id-card-name")).toHaveTextContent("Ghost");
      expect(card.querySelector(".id-card-photo img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
      expect(card).toHaveTextContent("Default");
      expect(within(card).getByTestId("identity-proof-subject")).toHaveTextContent("One key per chat");
      expect(card).toHaveTextContent("Used in 2 chats");
      // The first profile has no date of its own: since its first chat.
      expect(card).toHaveTextContent(`Since ${date(Date.UTC(2026, 0, 2) / 1000)}`);
      expect(card.querySelector("[data-deck=face]")).toHaveAttribute("data-status", "default");
      // Its panel: what it is, and where the name and picture are edited.
      const panelOf = screen.getByTestId("identity-ghostly-panel");
      expect(within(panelOf).getByTestId("identity-ghostly-name")).toHaveTextContent("Ghost");
      expect(within(panelOf).getByTestId("identity-panel-status")).toHaveTextContent("Default");
      expect(panelOf).toHaveTextContent("a key pair made for each chat");
      expect(screen.getByTestId("identity-ghostly-edit")).toHaveTextContent("Edit profile");
      // Still first, and still there, once proofs come.
      act(() => engine.update({ identityProofs: [proofView({ id: "a" })] }));
      expect(screen.getAllByRole("tab").map(t => t.dataset.testid)).toEqual(["identity-ghostly", "identity-proof", "identity-add"]);
    });

    it("shows the name's initial without a picture, and that name and picture are hidden when not shared", () => {
      const { engine } = renderApp(<IdentityProofsSection />);
      act(() => engine.update({ settings: { nick: "Ghost", avatar: undefined } }));
      expect(within(ghostly()).getByTestId("id-card-monogram")).toHaveTextContent("G");
      act(() => engine.update({ settings: { nick: "Ghost", shareProfile: false } }));
      expect(within(ghostly()).queryByTestId("id-card-monogram")).not.toBeInTheDocument();
      expect(within(ghostly()).getByTestId("id-card-name")).toHaveTextContent("Name and picture hidden");
    });

    it("its Edit profile opens the Profile page", async () => {
      const { user } = renderApp(<><IdentityProofsSection /><Where /></>);
      await user.click(screen.getByTestId("identity-ghostly-edit"));
      expect(screen.getByTestId("where")).toHaveTextContent("/profile");
    });
  });
});
