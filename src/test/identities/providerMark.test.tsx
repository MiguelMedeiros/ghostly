import type { ReactElement } from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderMark, StatusPill } from "../../components/identities/ProviderMark";
import { renderApp } from "../render";

// covers: proofs.share

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
