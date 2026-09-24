import type { ReactElement } from "react";
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { IdentityBadges } from "../../components/identities/IdentityBadges";
import { ProviderMark, StatusPill } from "../../components/identities/ProviderMark";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, receivedView } from "./views";


const withReceived = (received: ReceivedIdentityView[], patch: Partial<LinkView> = {}) =>
  ({ links: [linkView({ identities: identitiesView({ received }), ...patch })] });

/** The contact's verified identities beside its name in the chat header. */
describe("IdentityBadges", () => {
  it("shows nothing until the contact has a verified identity", () => {
    const { engine } = renderApp(<IdentityBadges peerKey="peer" onOpen={() => {}} />);
    expect(screen.queryByTestId("chat-identity-badges")).not.toBeInTheDocument();
    act(() => engine.update(withReceived([receivedView({ status: "unconfirmed" }), receivedView({ id: "r2", status: "revoked" })])));
    expect(screen.queryByTestId("chat-identity-badges")).not.toBeInTheDocument();
  });

  it("names only what is verified now, with its category, and opens the chat's identities", async () => {
    const onOpen = vi.fn();
    const { user, engine } = renderApp(<IdentityBadges peerKey="peer" onOpen={onOpen} />);
    act(() => engine.update(withReceived([
      receivedView({ id: "r1", provider: "domain", subject: "example.org" }),
      receivedView({ id: "r2", provider: "oidc", subject: "https://accounts.google.com", verified: { subject: "https://accounts.google.com#42", source: "ID token", attester: "accounts.google.com" } }),
      // Past its expiry: not a badge, even though the engine last said verified.
      receivedView({ id: "r3", provider: "domain", subject: "old.example", expiresAt: now() - DAY }),
      receivedView({ id: "r4", provider: "domain", subject: "gone.example", status: "withdrawn" }),
    ])));
    const badges = screen.getByRole("button", { name: /^Verified identities: / });
    expect(badges).toHaveAccessibleName("Verified identities: Domain example.org (verified, their own key), Account at a provider Google (verified, attested by accounts.google.com)");
    expect(badges.querySelectorAll("[data-icon]")).toHaveLength(2);
    await user.click(badges);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows at most three marks", () => {
    const { engine } = renderApp(<IdentityBadges peerKey="peer" onOpen={() => {}} />);
    act(() => engine.update(withReceived(["a", "b", "c", "d"].map((id) => receivedView({ id, subject: `${id}.example` })))));
    const badges = screen.getByTestId("chat-identity-badges");
    expect(badges.querySelectorAll("[data-icon]")).toHaveLength(3);
    // The label still names all four.
    expect(badges.getAttribute("aria-label")!.match(/verified, their own key/g)).toHaveLength(4);
  });

  it("belongs to the chat it is given", () => {
    const { engine } = renderApp(<IdentityBadges peerKey="someone-else" onOpen={() => {}} />);
    act(() => engine.update(withReceived([receivedView()])));
    expect(screen.queryByTestId("chat-identity-badges")).not.toBeInTheDocument();
  });
});

describe("ProviderMark", () => {
  const icon = (ui: ReactElement) => { const { container, unmount } = renderApp(ui); const key = container.querySelector("[aria-hidden]")?.getAttribute("data-icon") ?? null; unmount(); return key; };

  it("uses a registered provider's own mark", () => {
    expect(icon(<ProviderMark provider="nostr" />)).toBe("nostr");
    expect(icon(<ProviderMark provider="ssh-github" />)).toBe("ssh-github");
  });

  it("uses the named provider's mark for an OpenID Connect subject, the generic one otherwise", () => {
    expect(icon(<ProviderMark provider="oidc" subject="https://accounts.google.com" />)).toBe("oidc:google");
    expect(icon(<ProviderMark provider="oidc" subject="https://login.microsoftonline.com/{tenantid}/v2.0" />)).toBe("oidc:microsoft");
    expect(icon(<ProviderMark provider="oidc" subject="https://issuer.example" />)).toBe("oidc");
    expect(icon(<ProviderMark provider="oidc" />)).toBe("oidc");
  });

  it("falls back to a key for an unknown provider", () => {
    const { container } = renderApp(<ProviderMark provider="some-plugin" />);
    const mark = container.querySelector("[aria-hidden]")!;
    expect(mark).not.toHaveAttribute("data-icon");
    // The key's ring, not the attested shield.
    expect(mark.querySelector("circle")).not.toBeNull();
  });

  it("falls back to a shield for an attested provider without a mark", () => {
    // The e2e fakes have no mark; fake-account is attested.
    localStorage.setItem("ghostly-test-identities", "1");
    const { container } = renderApp(<ProviderMark provider="fake-account" />);
    const mark = container.querySelector("[aria-hidden]")!;
    expect(mark).not.toHaveAttribute("data-icon");
    expect(mark.querySelector("circle")).toBeNull();
  });

  it("is hidden from screen readers: the label beside it names the provider", () => {
    const { container } = renderApp(<ProviderMark provider="nostr" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});

describe("StatusPill", () => {
  it("ticks only what is ok", () => {
    const { rerender } = renderApp(<StatusPill ok testId="pill">Verified</StatusPill>);
    expect(screen.getByTestId("pill").querySelector("svg")).not.toBeNull();
    rerender(<StatusPill testId="pill">Expired</StatusPill>);
    expect(screen.getByTestId("pill").querySelector("svg")).toBeNull();
    expect(screen.getByTestId("pill")).toHaveTextContent("Expired");
  });
});
