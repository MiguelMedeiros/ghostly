import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProfileDidView } from "@ghostly/browser/shared/types";
import { IdentityProofsSection } from "../../components/identities/IdentityProofsSection";
import { renderApp as render } from "../render";
import { DAY, now, proofView } from "./views";

// covers: did.dht.public-links, did.dht.profile

const renderApp = (...args: Parameters<typeof render>) => { const shown = render(...args); document.documentElement.dataset.reduceMotion = "true"; return shown; };

const DID = "did:dht:cyuoqaf7itop8ohww4yn5ojg13qaq83r9zihgqntc5i9zwrfdfoo";
const didView = (patch: Partial<ProfileDidView> = {}): ProfileDidView => ({ id: DID, listed: [], alsoKnownAs: [], upToDate: false, ...patch });
const identities = () => screen.getAllByTestId("did-identity");
const switches = () => screen.getAllByTestId("did-list");
/** Proofs that arrive after the page mounted bring their card up (useNewProof): back to the Ghostly card. */
const ghostlyCard = (user: ReturnType<typeof renderApp>["user"]) => user.click(screen.getByTestId("identity-ghostly"));

/** Identities → Yours → the Ghostly card's details: the profile's public DID and what it lists. */
describe("Public DID", () => {
  it("shows the profile's did:dht with Copy and a QR code, and whether it is published", async () => {
    const { engine, user } = renderApp(<IdentityProofsSection />);
    expect(screen.queryByTestId("did-section")).not.toBeInTheDocument();
    act(() => engine.update({ did: didView() }));
    const section = screen.getByTestId("did-section");
    expect(within(section).getByTestId("did-id")).toHaveTextContent(DID);
    expect(section).toHaveTextContent("Public DID");
    expect(section).toHaveTextContent("no chat uses it");
    expect(screen.getByTestId("did-published")).toHaveTextContent("Not published");
    expect(screen.getByTestId("did-status")).toHaveTextContent("Publishing…");

    await user.click(screen.getByTestId("did-copy"));
    expect(await navigator.clipboard.readText()).toBe(DID);
    expect(screen.getByTestId("did-copy")).toHaveTextContent("Copied");

    expect(screen.queryByTestId("did-qr")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("did-qr-toggle"));
    expect(screen.getByTestId("did-qr").querySelector("svg")).toBeInTheDocument();
    expect(screen.getByTestId("did-qr-toggle")).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByTestId("did-qr-toggle"));
    expect(screen.queryByTestId("did-qr")).not.toBeInTheDocument();

    const at = Date.UTC(2026, 8, 25, 12, 0);
    act(() => engine.update({ did: didView({ published: { at, versionId: "1790000000" }, upToDate: true }) }));
    expect(screen.getByTestId("did-published")).toHaveTextContent("Published");
    expect(screen.getByTestId("did-status")).toHaveTextContent(`Published ${new Date(at).toLocaleString()}`);
    act(() => engine.update({ did: didView({ published: { at, versionId: "1790000000" }, upToDate: false }) }));
    expect(screen.getByTestId("did-status")).toHaveTextContent("Publishing the change…");
    act(() => engine.update({ did: didView({ published: { at, versionId: "1790000000" }, error: "Publish failed on every relay" }) }));
    expect(screen.getByTestId("did-status")).toHaveTextContent("Could not publish: Publish failed on every relay");
    act(() => engine.update({ did: didView(), settings: { online: false } }));
    expect(screen.getByTestId("did-status")).toHaveTextContent("Not published while the network is off.");
  });

  it("warns that listed identities are public for good, and has nothing to list without identities that have an address", async () => {
    const { engine, user } = renderApp(<IdentityProofsSection />);
    act(() => engine.update({ did: didView(), identityProofs: [proofView({ id: "ssh", provider: "ssh", subject: "SHA256:abc" })] }));
    await ghostlyCard(user);
    expect(screen.getByTestId("did-warning")).toHaveTextContent("public to everyone, for good");
    expect(screen.getByTestId("did-warning")).toHaveTextContent("some resolvers keep copies");
    expect(screen.getByTestId("did-none")).toBeInTheDocument();
    expect(screen.queryByTestId("did-list")).not.toBeInTheDocument();
  });

  it("offers a switch per identity, off by default, that lists it and takes it out", async () => {
    const { engine, user } = renderApp(<IdentityProofsSection />);
    engine.on("setDidListed", () => undefined);
    act(() => engine.update({ did: didView(), identityProofs: [
      proofView({ id: "domain", provider: "domain", subject: "example.com", publicUri: "https://example.com" }),
      proofView({ id: "ssh", provider: "ssh", subject: "SHA256:abc" }),
      proofView({ id: "github", provider: "ssh-github", subject: "octocat", verified: { subject: "octocat", source: "SSH signature" }, publicUri: "https://github.com/octocat" }),
    ] }));
    await ghostlyCard(user);
    expect(identities().map(i => i.dataset.proofId)).toEqual(["domain", "github"]);
    expect(identities()[0]).toHaveTextContent("https://example.com");
    expect(switches().map(s => s.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(switches()[1]).toHaveAccessibleName(/^List GitHub \(SSH key\) .*octocat publicly in my DID$/);

    await user.click(switches()[1]);
    expect(engine.callsTo("setDidListed")).toEqual([{ id: "github", listed: true }]);
    act(() => engine.update({ did: didView({ listed: ["github"], alsoKnownAs: ["https://github.com/octocat"] }) }));
    expect(switches().map(s => s.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    await user.click(switches()[1]);
    expect(engine.callsTo("setDidListed")).toEqual([{ id: "github", listed: true }, { id: "github", listed: false }]);
  });

  it("says why a listing was refused, and keeps an expired identity out until it is renewed", async () => {
    const { engine, user } = renderApp(<IdentityProofsSection />);
    engine.on("setDidListed", () => { throw new Error("Your DID has no room for another identity (1000 bytes). Take one out first."); });
    act(() => engine.update({ did: didView({ listed: ["old"] }), identityProofs: [
      proofView({ id: "domain", provider: "domain", subject: "example.com", publicUri: "https://example.com" }),
      proofView({ id: "old", provider: "domain", subject: "old.example", publicUri: "https://old.example", expiresAt: now() - DAY }),
      proofView({ id: "gone", provider: "domain", subject: "gone.example", publicUri: "https://gone.example", expiresAt: now() - DAY }),
    ] }));
    await ghostlyCard(user);
    await user.click(switches()[0]);
    expect(await screen.findByTestId("did-error")).toHaveTextContent("no room for another identity");
    // Listed but expired: still on, so it can be taken out; not listed and expired: cannot be turned on.
    expect(identities()[1]).toHaveTextContent("Expired: not listed until you renew it");
    expect(switches()[1]).toBeEnabled();
    expect(switches()[1]).toHaveAttribute("aria-checked", "true");
    expect(switches()[2]).toBeDisabled();
  });
});
