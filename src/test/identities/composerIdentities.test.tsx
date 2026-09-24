import { act, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { MessageInput } from "../../components/MessageInput";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { date } from "../../lib/identities";
import { DAY, identitiesView, now, proofView, sharedView } from "./views";

// covers: proofs.composer, proofs.share, proofs.withdraw

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
const panel = () => screen.getByTestId("composer-identity-panel");
const status = () => within(panel()).getByTestId("composer-identity-status").textContent;
const action = () => screen.getByTestId("composer-identity-share");
const chosen = () => screen.getAllByRole("tab").find(t => t.getAttribute("aria-selected") === "true");

/** The composer's identity picker: the profile's identities as ID cards, the chosen one shared or not in this chat only. */
describe("ComposerIdentityPicker", () => {
  it("is the blank card alone when the profile has none, which adds the first one without leaving the chat", async () => {
    const { user } = open({ links: [paired()], identityProofs: [] });
    expect(screen.getByRole("dialog", { name: "Your identities" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Your identities" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByTestId("composer-identity-add")).toHaveTextContent("Add your first identity");
    expect(screen.queryByTestId("composer-identity")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-identities-empty")).toHaveTextContent("No identities yet");
    expect(screen.queryByTestId("composer-identities-manage")).not.toBeInTheDocument();
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
    expect(screen.getAllByRole("tab").map(t => t.dataset.testid)).toEqual(["composer-identity", "composer-identity", "composer-identity", "composer-identity", "composer-identity-add"]);
    expect(cards().map(c => [within(c).getByTestId("identity-proof-subject").textContent, !!within(c).queryByTestId("id-card-shared")])).toEqual([
      ["example.com", true], ["example.net", false], ["example.org", true], ["example.info", false],
    ]);
    expect(cards()[0]).toHaveTextContent("Shared with Alice");
    expect(cards()[1]).toHaveTextContent("Not shared with Alice");
    expect(cards()[0]).toHaveTextContent("Domain");
    expect(cards()[0]).toHaveTextContent("Your own key");
    expect(cards()[0]).toHaveTextContent("Verified");
    // The first card is the chosen one, its panel below.
    expect(chosen()).toBe(cards()[0]);
    expect(panel()).toHaveAttribute("aria-labelledby", cards()[0].id);
  });

  it("shows the chosen card's detail: what the contact sees, where it stands here, and the action", async () => {
    const { user } = open({
      links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "a", status: "accepted" }), sharedView({ id: "d", status: "rejected", error: "bad signature" })] }) })],
      identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" }), proofView({ id: "d", subject: "example.biz" })],
    });
    expect(panel()).toHaveTextContent("What Alice sees");
    expect(panel()).toHaveTextContent("Domain example.com");
    expect(panel()).toHaveTextContent(`Your own key · Valid until ${date(now() + 30 * DAY)}`);
    expect(status()).toBe("Shared · verified by your contact");
    expect(action()).toHaveTextContent("Stop sharing");
    await user.click(cards()[1]);
    expect(chosen()).toBe(cards()[1]);
    expect(panel()).toHaveTextContent("Domain example.net");
    expect(status()).toBe("Not shared");
    expect(action()).toHaveTextContent("Share with this chat");
    await user.click(cards()[2]);
    expect(status()).toBe("Not verified by your contact: bad signature");
    expect(cards()[2]).toHaveTextContent("Check failed");
    expect(action()).toHaveTextContent("Stop sharing");
  });

  it("shares the chosen card and stops it, from its panel", async () => {
    const { user, engine } = open({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "off", subject: "example.net" }), proofView({ id: "on" })] });
    let finish = () => {};
    engine.on("shareIdentityProof", () => new Promise<void>(resolve => { finish = resolve; }));
    engine.on("withdrawIdentityProof", () => undefined);
    await user.click(action());
    expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "off" }]);
    // While the call runs the button keeps the focus and says so; a second press does nothing.
    expect(action()).toHaveTextContent("Sharing…");
    expect(action()).toHaveAttribute("aria-disabled", "true");
    expect(action()).toHaveFocus();
    await user.click(action());
    expect(engine.callsTo("shareIdentityProof")).toHaveLength(1);
    await act(async () => finish());
    expect(action()).not.toHaveAttribute("aria-disabled");
    await user.click(cards()[1]);
    await user.click(action());
    expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "on" }]);
  });

  it("moves along the cards with the keys, the panel following", async () => {
    const { user } = open({ links: [paired()], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] });
    act(() => cards()[0].focus());
    await user.keyboard("{ArrowRight}");
    expect(chosen()).toBe(cards()[1]);
    expect(cards()[1]).toHaveFocus();
    expect(panel()).toHaveTextContent("example.net");
    await user.keyboard("{End}");
    expect(chosen()).toBe(screen.getByTestId("composer-identity-add"));
    expect(screen.getByTestId("composer-identities-add")).toHaveTextContent("Add identity");
    await user.keyboard("{Home}");
    expect(chosen()).toBe(cards()[0]);
  });

  it("does not offer an expired identity, and warns about one expiring soon", async () => {
    const { user } = open({ links: [paired()], identityProofs: [
      proofView({ id: "old", issuedAt: now() - 100 * DAY, expiresAt: now() - DAY }),
      proofView({ id: "soon", subject: "example.net", issuedAt: now() - 80 * DAY, expiresAt: now() + 2 * DAY }),
    ] });
    expect(cards()[0]).toHaveAttribute("aria-disabled", "true");
    expect(status()).toMatch(/^Expired /);
    expect(action()).toBeDisabled();
    await user.click(cards()[1]);
    expect(cards()[1]).not.toHaveAttribute("aria-disabled");
    expect(action()).toBeEnabled();
    expect(within(panel()).getByTestId("composer-identity-expiring")).toHaveTextContent("Expires in 2 days");
  });

  it("does not share what the contact's app cannot receive or verify, but can always stop", async () => {
    const { user } = open({ links: [paired({ identities: identitiesView({ contactProviders: ["nostr"], shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "off", subject: "example.net" }), proofView({ id: "on" })] });
    expect(cards()[0]).toHaveAttribute("aria-disabled", "true");
    expect(cards()[0]).toHaveAttribute("title", "Alice’s app cannot verify Domain yet");
    expect(status()).toBe("Alice’s app cannot verify Domain yet");
    expect(action()).toBeDisabled();
    await user.click(cards()[1]);
    expect(action()).toBeEnabled();
    expect(action()).toHaveTextContent("Stop sharing");
  });

  it("says when the contact's app cannot receive identities at all", () => {
    open({ links: [paired({ identities: identitiesView({ support: false }) })], identityProofs: [proofView()] });
    expect(screen.getByTestId("composer-identities-unsupported")).toHaveTextContent("Alice’s app cannot receive identities yet.");
    expect(action()).toBeDisabled();
  });

  it("shows the engine's refusal, and leads to the Identities page to manage them", async () => {
    const { user, engine, onClose } = open({ links: [paired()], identityProofs: [proofView()] });
    engine.on("shareIdentityProof", () => { throw new Error("Connect to this contact first"); });
    await user.click(action());
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect to this contact first");
    await user.click(screen.getByRole("button", { name: "Manage identities" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("brings up an identity added while it is open", () => {
    const { engine } = open({ links: [paired()], identityProofs: [proofView({ id: "a" })] });
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "new", subject: "example.net" })] }));
    expect(chosen()).toBe(cards()[1]);
    expect(panel()).toHaveTextContent("example.net");
  });

  it("closes on Escape", async () => {
    const { user, onClose } = open({ links: [paired()], identityProofs: [proofView()] });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("MessageInput: the identity button", () => {
  const input = (identities?: { peerKey: string; contact: string }) => renderApp(<MessageInput onSend={async () => null} identities={identities} />);

  it("is there only for a chat that can share identities", () => {
    input();
    expect(screen.queryByTestId("composer-identities-button")).not.toBeInTheDocument();
  });

  it("counts what is shared in this chat, and opens the picker with the focus in it", async () => {
    const { user, engine } = input({ peerKey: "peer", contact: "Alice" });
    act(() => engine.update({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "a" }), sharedView({ id: "b", status: "withdrawn" })] }) })], identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    const button = screen.getByRole("button", { name: "Share identities in this chat, 1 shared" });
    expect(within(button).getByTestId("composer-identities-count")).toHaveTextContent("1");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("composer-identities")).toBeInTheDocument();
    expect(cards()[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-identities")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("has no count when nothing is shared", () => {
    const { engine } = input({ peerKey: "peer", contact: "Alice" });
    act(() => engine.update({ links: [paired()], identityProofs: [proofView()] }));
    expect(screen.getByRole("button", { name: "Share identities in this chat" })).toBeInTheDocument();
    expect(screen.queryByTestId("composer-identities-count")).not.toBeInTheDocument();
  });
});
