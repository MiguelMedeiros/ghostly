import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IdentityProofsSection } from "../../components/identities/IdentityProofsSection";
import { date } from "../../lib/identities";
import { renderApp } from "../render";
import { DAY, now, proofView } from "./views";

// covers: proofs.revoke, proofs.expiry


const rows = () => screen.getAllByTestId("identity-proof");

/** Profile → Identities: the proofs this profile holds. */
describe("IdentityProofsSection", () => {
  it("explains what identities are while there are none, and offers to add one", async () => {
    const { user } = renderApp(<IdentityProofsSection />);
    expect(screen.getByTestId("profile-identities")).toHaveTextContent("Prove that you hold a Nostr key or another identity");
    expect(screen.queryByTestId("identity-proof")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("identity-add"));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists each proof with its provider, subject, validity and how many chats it is shared in", () => {
    const valid = now() + 30 * DAY, gone = now() - 2 * DAY;
    const { engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [
      proofView({ id: "a", provider: "domain", subject: "example.com", expiresAt: valid }),
      proofView({ id: "b", provider: "oidc", subject: "https://accounts.google.com", expiresAt: valid, sharedWith: 1,
        verified: { subject: "https://accounts.google.com#1234", source: "ID token signed by accounts.google.com", attester: "accounts.google.com" } }),
      proofView({ id: "c", provider: "ssh-github", subject: "octocat", expiresAt: gone, sharedWith: 3, verified: { subject: "octocat", source: "SSH signature" } }),
    ] }));
    const [domain, oidc, github] = rows();
    expect(domain).toHaveTextContent("Domain");
    expect(domain).toHaveTextContent("Your key");
    expect(within(domain).getByTestId("identity-proof-subject")).toHaveTextContent("example.com");
    expect(domain).toHaveTextContent(`Until ${date(valid)} · Not shared`);

    expect(oidc).toHaveTextContent("Account at a provider");
    expect(oidc).toHaveTextContent("Attested by accounts.google.com");
    // The full account is kept in the title; the row shows the provider.
    expect(within(oidc).getByTestId("identity-proof-subject")).toHaveAttribute("title", "https://accounts.google.com#1234");
    expect(oidc).toHaveTextContent("Shared in 1 chat");
    expect(oidc).not.toHaveTextContent("Shared in 1 chats");

    expect(github).toHaveTextContent("GitHub (SSH key)");
    expect(github).toHaveTextContent("Expired");
    expect(github).not.toHaveTextContent("Your key");
    expect(github).toHaveTextContent(`Expired ${date(gone)} · Shared in 3 chats`);
  });

  it("names a proof from a provider this app does not know by its id", () => {
    const { engine } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ identityProofs: [proofView({ provider: "some-plugin", subject: "alice", verified: { subject: "alice", source: "Plugin" } })] }));
    expect(rows()[0]).toHaveTextContent("some-plugin");
  });

  it("asks before removing, says what removing does, and asks the engine", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    engine.on("removeIdentityProof", () => undefined);
    act(() => engine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net" })] }));
    await user.click(within(rows()[1]).getByTestId("identity-proof-remove"));
    expect(screen.getByText(/a revocation is published/)).toBeInTheDocument();
    // Only that row asks.
    expect(within(rows()[0]).getByTestId("identity-proof-remove")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove and stop sharing" }));
    expect(engine.callsTo("removeIdentityProof")).toEqual([{ id: "b" }]);
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

  it("shows why a removal failed and keeps asking", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    engine.on("removeIdentityProof", () => { throw new Error("The revocation could not be published"); });
    act(() => engine.update({ identityProofs: [proofView()] }));
    await user.click(screen.getByTestId("identity-proof-remove"));
    await user.click(screen.getByTestId("identity-proof-remove-confirm"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The revocation could not be published");
    expect(screen.getByTestId("identity-proof-remove-confirm")).toBeInTheDocument();
  });
});
