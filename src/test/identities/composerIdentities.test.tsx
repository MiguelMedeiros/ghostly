import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ComposerIdentityPicker, DONE_MS, IdentityPicker } from "../../components/identities/ComposerIdentities";
import { MessageInput } from "../../components/MessageInput";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { date } from "../../lib/identities";
import { DAY, identitiesView, now, proofView, sharedView } from "./views";

// covers: proofs.composer, proofs.share, proofs.withdraw, proofs.ghostly-card

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** A paired chat with Alice, connected now. */
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

function open(state: Parameters<ReturnType<typeof renderApp>["engine"]["update"]>[0]) {
  const onClose = vi.fn();
  const result = renderApp(<>
    <ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={onClose} />
    <Routes><Route path="*" element={<Where />} /></Routes>
  </>);
  // The swing a card makes as it comes up is skipped: only the choice is tested (set after the render, which applies
  // the profile's own setting as it mounts).
  document.documentElement.dataset.reduceMotion = "true";
  act(() => result.engine.update(state));
  return { onClose, ...result };
}

const cards = () => screen.getAllByTestId("composer-identity");
const ghostly = () => screen.getByTestId("composer-identity-ghostly");
const chosen = () => screen.getAllByRole("radio").find(t => t.getAttribute("aria-checked") === "true");
const hint = () => screen.getByTestId("composer-identity-hint").textContent;
const use = () => screen.getByTestId("composer-identity-use");
const sheet = () => screen.getByTestId("composer-identities");
const back = () => screen.getByTestId("composer-identity-back");
const status = () => within(back()).getByTestId("composer-identity-status").textContent;
const action = () => screen.getByTestId("composer-identity-share");
/** The card turned over and settled: its action has the keys (the back takes them only once it faces up). */
async function turned() {
  await waitFor(() => expect(action()).toHaveFocus());
  expect(sheet()).toHaveAttribute("data-side", "back");
  expect(sheet().querySelector(".composer-identity-flip")).toHaveAttribute("data-flipped", "true");
}
/** Back on the deck: after the back said it was done, and the card turned face up again. */
const deckAgain = () => screen.findByRole("radiogroup", { name: "Your identities" }, { timeout: DONE_MS + 2000 });

/**
 * The composer's identity picker, step for step as the payment picker: the profile's identities as ID cards, one
 * line on what the chosen one shows the contact, "Use …", and the card turns over to share it or stop, here only.
 */
describe("ComposerIdentityPicker", () => {
  it("is the Ghostly card and the blank one when the profile has no proofs, and the blank one adds the first without leaving the chat", async () => {
    const { user } = open({ links: [paired()], identityProofs: [] });
    expect(screen.getByRole("dialog", { name: "Your identities" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Your identities" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map(t => t.dataset.testid)).toEqual(["composer-identity-ghostly", "composer-identity-add"]);
    expect(chosen()).toBe(ghostly());
    expect(screen.getByTestId("composer-identity-add")).toHaveTextContent("Add an identity");
    expect(screen.queryByTestId("composer-identity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-identities-manage")).not.toBeInTheDocument();
    await user.keyboard("{End}");
    expect(chosen()).toBe(screen.getByTestId("composer-identity-add"));
    expect(screen.getByTestId("composer-identities-empty")).toHaveTextContent("No other identities yet.");
    await user.click(screen.getByTestId("composer-identities-add"));
    // The dialog takes the sheet's place while it is open, and the sheet comes back with the focus on its card.
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
    expect(screen.queryByTestId("composer-identities")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("composer-identities")).toBeInTheDocument();
    expect(screen.getByTestId("composer-identity-add")).toHaveFocus();
    // The blank card opens it too.
    await user.click(screen.getByTestId("composer-identity-add"));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
  });

  it("makes an ID card of each identity, a check seal on those shared here, and ends with Add identity", () => {
    open({
      links: [paired({ identities: identitiesView({ shared: [
        sharedView({ id: "a", status: "accepted" }),
        sharedView({ id: "b", status: "withdrawn" }),
        sharedView({ id: "c", status: "pending" }),
      ] }) })],
      identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" }), proofView({ id: "c", subject: "example.org" }), proofView({ id: "d", subject: "example.info" })],
    });
    expect(screen.getAllByRole("radio").map(t => t.dataset.testid)).toEqual(["composer-identity-ghostly", "composer-identity", "composer-identity", "composer-identity", "composer-identity", "composer-identity-add"]);
    expect(cards().map(c => [within(c).getByTestId("identity-proof-subject").textContent, !!within(c).queryByTestId("id-card-shared")])).toEqual([
      ["example.com", true], ["example.net", false], ["example.org", true], ["example.info", false],
    ]);
    expect(cards()[0]).toHaveTextContent("Shared with Alice");
    expect(cards()[1]).toHaveTextContent("Not shared with Alice");
    expect(cards()[0]).toHaveTextContent("Domain");
    expect(cards()[0]).toHaveTextContent("Your own key");
    expect(cards()[0]).toHaveTextContent("Verified");
    // The proof just made is the chosen one; no panel under the deck, one line and one action, as the payment picker.
    expect(chosen()).toBe(cards()[0]);
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.queryByText(/What Alice sees/)).not.toBeInTheDocument();
    expect(hint()).toBe(`Alice sees your domain example.com, your own key, valid until ${date(now() + 30 * DAY)}.`);
    expect(use()).toHaveTextContent("Use Domain");
    expect(screen.getByTestId("composer-identities-manage")).toHaveTextContent("Manage identities");
  });

  it("says what the chosen card would show the contact, as it comes up", async () => {
    const { user } = open({ links: [paired()], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] });
    act(() => cards()[0].focus());
    await user.keyboard("{ArrowRight}");
    expect(chosen()).toBe(cards()[1]);
    expect(hint()).toBe(`Alice will see your domain example.net, your own key, valid until ${date(now() + 30 * DAY)}.`);
    // Only selected: nothing turned over yet.
    expect(sheet()).toHaveAttribute("data-side", "cards");
  });

  it("turns the chosen card over to share it, and closes once it is shared: the chat's timeline shows the share", async () => {
    const { user, engine, onClose } = open({ links: [paired()], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] });
    let finish = () => {};
    engine.on("shareIdentityProof", () => new Promise<void>(resolve => { finish = resolve; }));
    await user.click(cards()[1]);
    await turned();
    // The back: what Alice sees, where it stands here, and the action.
    expect(back()).toHaveTextContent("What Alice sees");
    expect(within(back()).getByTestId("composer-identity-sees")).toHaveTextContent("Domain");
    expect(within(back()).getByTestId("composer-identity-sees")).toHaveTextContent("example.net");
    expect(within(back()).getByTestId("composer-identity-sees")).toHaveTextContent(`Your own key · Valid until ${date(now() + 30 * DAY)}`);
    expect(status()).toBe("Not shared");
    expect(action()).toHaveTextContent("Share with Alice");
    expect(back()).not.toHaveTextContent("a copy they kept stays");
    await user.click(action());
    expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "b" }]);
    // While the call runs the button keeps the focus and says so; a second press does nothing.
    expect(action()).toHaveTextContent("Sharing…");
    expect(action()).toHaveAttribute("aria-disabled", "true");
    expect(action()).toHaveFocus();
    await user.click(action());
    expect(engine.callsTo("shareIdentityProof")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("in the chat's panel, a share stays open: the back says so, then the card comes back wearing the seal", async () => {
    const result = renderApp(<IdentityPicker peerKey="peer" contact="Alice" onManage={() => {}}
      frame={({ side }, children) => <div data-testid="composer-identities" data-side={side}>{children}</div>} />);
    document.documentElement.dataset.reduceMotion = "true";
    act(() => result.engine.update({ links: [paired()], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    result.engine.on("shareIdentityProof", () => undefined);
    await result.user.click(cards()[1]);
    await turned();
    await result.user.click(action());
    act(() => result.engine.update({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "b", subject: "example.net", status: "pending" })] }) })] }));
    expect(await within(back()).findByTestId("composer-identity-done")).toHaveTextContent("Shared with Alice");
    expect(within(back()).queryByTestId("composer-identity-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-identity-share")).not.toBeInTheDocument();
    // Then the deck, the same card chosen and with the keys, wearing the seal.
    await deckAgain();
    expect(chosen()).toBe(cards()[1]);
    expect(within(cards()[1]).getByTestId("id-card-shared")).toBeInTheDocument();
    await waitFor(() => expect(cards()[1]).toHaveFocus());
    expect(hint()).toMatch(/^Alice sees your domain example.net/);
  });

  it("stops sharing from the back, with the note that a kept copy stays, and the seal goes", async () => {
    const { user, engine } = open({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "on" })] });
    engine.on("withdrawIdentityProof", () => undefined);
    expect(within(cards()[0]).getByTestId("id-card-shared")).toBeInTheDocument();
    await user.click(use());
    await turned();
    expect(status()).toBe("Shared · verified by your contact");
    expect(action()).toHaveTextContent("Stop sharing");
    expect(action()).toHaveAttribute("data-variant", "secondary");
    expect(back()).toHaveTextContent("Stopping tells Alice; a copy they kept stays.");
    await user.click(action());
    expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "on" }]);
    act(() => engine.update({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "on", status: "withdrawn" })] }) })] }));
    expect(await within(back()).findByTestId("composer-identity-done")).toHaveTextContent("Alice no longer sees it");
    await deckAgain();
    expect(within(cards()[0]).queryByTestId("id-card-shared")).not.toBeInTheDocument();
    expect(cards()[0]).toHaveTextContent("Not shared with Alice");
  });

  it("turns over with Enter and back to the deck with Cards, doing nothing", async () => {
    const { user, engine } = open({ links: [paired()], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] });
    act(() => cards()[0].focus());
    await user.keyboard("{Enter}");
    await turned();
    expect(back()).toHaveTextContent("example.com");
    await user.click(screen.getByRole("button", { name: "Choose another identity" }));
    await deckAgain();
    expect(chosen()).toBe(cards()[0]);
    await waitFor(() => expect(cards()[0]).toHaveFocus());
    expect(engine.callsTo("shareIdentityProof")).toEqual([]);
  });

  it("shows why a contact's app refused a shared identity, on its back", async () => {
    const { user } = open({
      links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "d", status: "rejected", error: "bad signature" })] }) })],
      identityProofs: [proofView({ id: "d", subject: "example.biz" })],
    });
    expect(cards()[0]).toHaveTextContent("Check failed");
    await user.click(use());
    await turned();
    expect(status()).toBe("Not verified by your contact: bad signature");
    expect(action()).toHaveTextContent("Stop sharing");
  });

  it("moves along the cards with the keys, the line following", async () => {
    const { user } = open({ links: [paired()], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] });
    act(() => cards()[0].focus());
    await user.keyboard("{ArrowRight}");
    expect(chosen()).toBe(cards()[1]);
    expect(cards()[1]).toHaveFocus();
    expect(hint()).toContain("example.net");
    await user.keyboard("{End}");
    expect(chosen()).toBe(screen.getByTestId("composer-identity-add"));
    expect(screen.getByTestId("composer-identities-add")).toHaveTextContent("Add another identity");
    await user.keyboard("{Home}");
    expect(chosen()).toBe(ghostly());
    expect(hint()).toBe("Alice sees your Ghostly identity, Ghost, and this chat's key me.");
    expect(use()).toHaveTextContent("Use Ghostly");
  });

  it("does not turn an expired identity over but leads to Manage, and warns on the back about one expiring soon", async () => {
    const { user } = open({ links: [paired()], identityProofs: [
      proofView({ id: "old", issuedAt: now() - 100 * DAY, expiresAt: now() - DAY }),
      proofView({ id: "soon", subject: "example.net", issuedAt: now() - 80 * DAY, expiresAt: now() + 2 * DAY }),
    ] });
    expect(cards()[0]).toHaveAttribute("aria-disabled", "true");
    expect(hint()).toMatch(/^Expired /);
    await user.click(cards()[0]);
    expect(sheet()).toHaveAttribute("data-side", "cards");
    expect(use()).toHaveTextContent("Manage");
    expect(use()).toHaveAttribute("data-action", "manage");
    await user.click(cards()[1]);
    await turned();
    expect(within(back()).getByTestId("composer-identity-expiring")).toHaveTextContent("Expires in 2 days");
  });

  it("an expired card's Manage opens the Identities page", async () => {
    const { user, onClose } = open({ links: [paired()], identityProofs: [proofView({ expiresAt: now() - DAY })] });
    await user.click(use());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("does not share what the contact's app cannot receive or verify, but can always stop", async () => {
    const { user } = open({ links: [paired({ identities: identitiesView({ contactProviders: ["nostr"], shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "off", subject: "example.net" }), proofView({ id: "on" })] });
    expect(cards()[0]).toHaveAttribute("aria-disabled", "true");
    expect(cards()[0]).toHaveAttribute("title", "Alice’s app cannot verify Domain yet");
    expect(hint()).toBe("Alice’s app cannot verify Domain yet");
    expect(use()).toBeDisabled();
    await user.click(cards()[1]);
    await turned();
    expect(action()).toHaveTextContent("Stop sharing");
  });

  it("says when the contact's app cannot receive identities at all", () => {
    open({ links: [paired({ identities: identitiesView({ support: false }) })], identityProofs: [proofView()] });
    expect(hint()).toBe("Alice’s app cannot receive identities yet");
    expect(use()).toBeDisabled();
  });

  it("stays open with the engine's refusal on the back, and leads to the Identities page to manage them", async () => {
    const { user, engine, onClose } = open({ links: [paired()], identityProofs: [proofView()] });
    engine.on("shareIdentityProof", () => { throw new Error("Connect to this contact first"); });
    await user.click(use());
    await turned();
    await user.click(action());
    expect(await within(back()).findByRole("alert")).toHaveTextContent("Connect to this contact first");
    expect(action()).toHaveTextContent("Share with Alice");
    // Retry is the same button: the second try goes through, and the sheet closes.
    expect(onClose).not.toHaveBeenCalled();
    engine.on("shareIdentityProof", () => undefined);
    await user.click(action());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    onClose.mockClear();
    await user.click(screen.getByRole("button", { name: "Choose another identity" }));
    await deckAgain();
    await user.click(screen.getByRole("button", { name: "Manage identities" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("brings up an identity added while it is open", () => {
    const { engine } = open({ links: [paired()], identityProofs: [proofView({ id: "a" })] });
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "new", subject: "example.net" })] }));
    expect(chosen()).toBe(cards()[1]);
    expect(hint()).toContain("example.net");
  });

  it("closes on Escape, from the deck or from a card's back", async () => {
    const first = open({ links: [paired()], identityProofs: [proofView()] });
    await first.user.keyboard("{Escape}");
    expect(first.onClose).toHaveBeenCalled();
    first.unmount();
    const second = open({ links: [paired()], identityProofs: [proofView()] });
    await second.user.click(cards()[0]);
    await turned();
    await second.user.keyboard("{Escape}");
    expect(second.onClose).toHaveBeenCalled();
  });
});

describe("MessageInput: the + menu's Identity row", () => {
  const input = (identities?: { peerKey: string; contact: string }) => renderApp(<MessageInput onSend={async () => null} identities={identities} />);
  const plus = () => screen.getByRole("button", { name: "Attach" });

  it("is there only for a chat that can share identities", async () => {
    const { user } = input();
    // With nothing to attach (no files, wallet or identities), the + has no menu to open.
    expect(plus()).toBeDisabled();
    await user.click(plus());
    expect(screen.queryByTestId("composer-identities-button")).not.toBeInTheDocument();
  });

  it("says how many are shared in this chat, and opens the picker with the focus in it", async () => {
    const { user, engine } = input({ peerKey: "peer", contact: "Alice" });
    act(() => engine.update({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "a" }), sharedView({ id: "b", status: "withdrawn" })] }) })], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    await user.click(plus());
    const row = screen.getByTestId("composer-identities-button");
    expect(row).toHaveAttribute("data-count", "1");
    expect(row).toHaveTextContent("Identity1 shared in this chat");
    await user.click(row);
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-identities")).toBeInTheDocument();
    // The Ghostly card, first and chosen, has the keys.
    expect(ghostly()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-identities")).not.toBeInTheDocument();
    expect(plus()).toHaveFocus();
  });

  it("closes the picker once an identity is shared, and gives the keys back to the message", async () => {
    const { user, engine } = input({ peerKey: "peer", contact: "Alice" });
    act(() => engine.update({ links: [paired()], identityProofs: [proofView({ id: "a" })] }));
    engine.on("shareIdentityProof", () => undefined);
    await user.click(plus());
    await user.click(screen.getByTestId("composer-identities-button"));
    document.documentElement.dataset.reduceMotion = "true";
    await user.click(cards()[0]);
    await turned();
    await user.click(action());
    await waitFor(() => expect(screen.queryByTestId("composer-identities")).not.toBeInTheDocument());
    expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "a" }]);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });

  it("has no count when nothing is shared", async () => {
    const { user, engine } = input({ peerKey: "peer", contact: "Alice" });
    act(() => engine.update({ links: [paired()], identityProofs: [proofView()] }));
    await user.click(plus());
    expect(screen.getByTestId("composer-identities-button")).toHaveAttribute("data-count", "0");
    expect(screen.getByTestId("composer-identities-button")).toHaveTextContent(/^Identity$/);
  });

  describe("the Ghostly card", () => {
    const KEY = "yzk3gq8qpjb1g4mzr3ff3kr1j4c1b7dxy8dd3mkwqc9k7p3e1mio";
    const withKey = (patch: Partial<LinkView> = {}) => paired({ myPubKeyZ32: KEY, ...patch });

    it("comes first, wearing the seal: the profile's name and picture, this chat's key, and what Alice sees", () => {
      open({ settings: { nick: "Ghost", avatar: "data:image/jpeg;base64,AAAA" }, links: [withKey()], identityProofs: [] });
      const card = ghostly();
      expect(screen.getAllByRole("radio")[0]).toBe(card);
      expect(card).toHaveClass("id-card-ghostly");
      expect(card).toHaveTextContent("Ghostly");
      expect(within(card).getByTestId("id-card-name")).toHaveTextContent("Ghost");
      expect(card.querySelector(".id-card-photo img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
      expect(within(card).getByTestId("identity-proof-subject")).toHaveTextContent("yzk3gq8q…1mio");
      expect(within(card).getByTestId("identity-proof-subject")).toHaveAttribute("title", KEY);
      expect(card).toHaveTextContent("Default");
      expect(card).toHaveTextContent("Your key in this chat");
      expect(card).toHaveTextContent("Shared with Alice");
      expect(within(card).getByTestId("id-card-shared")).toBeInTheDocument();
      expect(card).not.toHaveAttribute("aria-disabled");
      expect(hint()).toBe("Alice sees your Ghostly identity, Ghost, and this chat's key yzk3gq8q…1mio.");
      expect(use()).toHaveTextContent("Use Ghostly");
      expect(use()).toBeEnabled();
    });

    it("is never blocked, even before the contact's app is known", () => {
      open({ links: [linkView({ myPubKeyZ32: KEY })], identityProofs: [] });
      expect(ghostly()).not.toHaveAttribute("aria-disabled");
      expect(hint()).toMatch(/^Alice sees your Ghostly identity/);
    });

    it("turns over to the key in full, to copy, and says Alice sees only this when nothing else is shared", async () => {
      const { user } = open({ settings: { nick: "Ghost" }, links: [withKey()], identityProofs: [proofView({ id: "a" })] });
      await user.click(ghostly());
      await waitFor(() => expect(screen.getByTestId("composer-identity-copy-key")).toHaveFocus());
      expect(sheet()).toHaveAttribute("data-side", "back");
      expect(back()).toHaveAttribute("data-ghostly", "true");
      expect(back()).toHaveTextContent("What Alice sees");
      expect(within(back()).getByTestId("composer-identity-sees")).toHaveTextContent("Ghostly · Ghost");
      expect(within(back()).getByTestId("composer-identity-key")).toHaveTextContent(KEY);
      expect(status()).toBe("Alice sees only this identity");
      // Nothing to take back: no Share only this.
      expect(screen.queryByTestId("composer-identity-share")).not.toBeInTheDocument();
      await user.click(screen.getByTestId("composer-identity-copy-key"));
      expect(await navigator.clipboard.readText()).toBe(KEY);
      expect(screen.getByTestId("composer-identity-copy-key")).toHaveTextContent("Copied");
      // Back to the cards, the Ghostly card chosen.
      await user.click(screen.getByRole("button", { name: "Choose another identity" }));
      await deckAgain();
      expect(chosen()).toBe(ghostly());
    });

    it("Share only this takes every other shared identity back from Alice, then says so", async () => {
      const { user, engine } = open({
        links: [withKey({ identities: identitiesView({ shared: [sharedView({ id: "a", status: "accepted" }), sharedView({ id: "b", status: "pending" }), sharedView({ id: "c", status: "withdrawn" })] }) })],
        identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" }), proofView({ id: "c", subject: "example.org" })],
      });
      engine.on("withdrawIdentityProof", () => undefined);
      await user.click(ghostly());
      await turned();
      expect(status()).toBe("Alice also sees 2 other identities");
      expect(action()).toHaveTextContent("Share only this");
      await user.click(action());
      expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "a" }, { linkId: "link-1", id: "b" }]);
      expect(await within(back()).findByTestId("composer-identity-done")).toHaveTextContent("Only your Ghostly identity is shared");
      act(() => engine.update({ links: [withKey({ identities: identitiesView({ shared: [sharedView({ id: "a", status: "withdrawn" }), sharedView({ id: "b", status: "withdrawn" }), sharedView({ id: "c", status: "withdrawn" })] }) })] }));
      await deckAgain();
      expect(chosen()).toBe(ghostly());
      expect(cards().every(c => !within(c).queryByTestId("id-card-shared"))).toBe(true);
    });

    it("says one other identity in the singular", async () => {
      const { user } = open({ links: [withKey({ identities: identitiesView({ shared: [sharedView({ id: "a", status: "accepted" })] }) })], identityProofs: [proofView({ id: "a" })] });
      await user.click(ghostly());
      await turned();
      expect(status()).toBe("Alice also sees 1 other identity");
    });
  });
});
