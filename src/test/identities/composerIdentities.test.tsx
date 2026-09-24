import { act, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { MessageInput } from "../../components/MessageInput";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
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
  act(() => result.engine.update(state));
  return { onClose, ...result };
}

const rows = () => screen.getAllByTestId("composer-identity");
const status = (row: HTMLElement) => within(row).getByTestId("composer-identity-status").textContent;

/** The composer's identity picker: one switch per identity of this profile, for this chat only. */
describe("ComposerIdentityPicker", () => {
  it("offers to add one when the profile has none, leading to the Identities page", async () => {
    const { user, onClose } = open({ links: [paired()], identityProofs: [] });
    expect(screen.getByRole("dialog", { name: "Your identities" })).toBeInTheDocument();
    expect(screen.getByTestId("composer-identities-empty")).toHaveTextContent("No identities yet");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add one" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("shows each identity as a switch, on only where it is shared in this chat", () => {
    open({
      links: [paired({ identities: identitiesView({ shared: [
        sharedView({ id: "a", status: "accepted" }),
        sharedView({ id: "b", status: "withdrawn" }),
        sharedView({ id: "c", status: "pending" }),
        sharedView({ id: "d", status: "rejected", error: "bad signature" }),
      ] }) })],
      identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" }), proofView({ id: "c", subject: "example.org" }), proofView({ id: "d", subject: "example.biz" }), proofView({ id: "e", subject: "example.info" })],
    });
    expect(rows().map(r => [r.getAttribute("aria-checked"), status(r)])).toEqual([
      ["true", "Shared · verified by your contact"],
      ["false", "Not shared"],
      ["true", "Waiting for your contact"],
      ["true", "Not verified by your contact: bad signature"],
      ["false", "Not shared"],
    ]);
    expect(screen.getByRole("switch", { name: "Domain example.com" })).toBeEnabled();
  });

  it("shares with one tap and stops with another", async () => {
    const { user, engine } = open({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "off", subject: "example.net" }), proofView({ id: "on" })] });
    engine.on("shareIdentityProof", () => undefined);
    engine.on("withdrawIdentityProof", () => undefined);
    await user.click(rows()[0]);
    expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "off" }]);
    await user.click(rows()[1]);
    expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "on" }]);
  });

  it("does not offer an expired identity, and warns about one expiring soon", () => {
    open({ links: [paired()], identityProofs: [
      proofView({ id: "old", issuedAt: now() - 100 * DAY, expiresAt: now() - DAY }),
      proofView({ id: "soon", subject: "example.net", issuedAt: now() - 80 * DAY, expiresAt: now() + 2 * DAY }),
    ] });
    expect(rows()[0]).toBeDisabled();
    expect(status(rows()[0])).toMatch(/^Expired /);
    expect(rows()[1]).toBeEnabled();
    expect(within(rows()[1]).getByTestId("composer-identity-expiring")).toHaveTextContent("Expires in 2 days");
  });

  it("does not share what the contact's app cannot receive or verify, but can always stop", () => {
    open({ links: [paired({ identities: identitiesView({ contactProviders: ["nostr"], shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "off", subject: "example.net" }), proofView({ id: "on" })] });
    expect(rows()[0]).toBeDisabled();
    expect(status(rows()[0])).toBe("Alice’s app cannot verify Domain yet");
    expect(rows()[1]).toBeEnabled();
  });

  it("says when the contact's app cannot receive identities at all", () => {
    open({ links: [paired({ identities: identitiesView({ support: false }) })], identityProofs: [proofView()] });
    expect(screen.getByTestId("composer-identities-unsupported")).toHaveTextContent("Alice’s app cannot receive identities yet.");
    expect(rows()[0]).toBeDisabled();
  });

  it("shows the engine's refusal, and leads to the Identities page to manage them", async () => {
    const { user, engine, onClose } = open({ links: [paired()], identityProofs: [proofView()] });
    engine.on("shareIdentityProof", () => { throw new Error("Connect to this contact first"); });
    await user.click(rows()[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect to this contact first");
    await user.click(screen.getByRole("button", { name: "Manage identities" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
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
    expect(rows()[0]).toHaveFocus();
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
