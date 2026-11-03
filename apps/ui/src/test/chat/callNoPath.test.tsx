import { screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CALLS_BLOCKED_GUIDE, CallNoPathNotice } from "../../components/CallNoPathNotice";
import { renderApp } from "../render";

// covers: calls.no-path

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe("the note when a call found no path to the contact", () => {
  it("says why in one plain sentence, points to Settings, Network and to the guide, and closes", async () => {
    const onClose = vi.fn();
    const view = renderApp(<><Where /><CallNoPathNotice onClose={onClose} /></>, { route: "/chat/abc" });
    const note = screen.getByRole("alert");
    expect(note).toHaveTextContent("The call couldn't connect");
    expect(note).toHaveTextContent("A VPN or firewall, yours or your contact's, may block calls. A TURN server gets them through.");
    // It never says a VPN was found: the app only sees that the call found no path.
    expect(note).not.toHaveTextContent(/VPN detected/i);

    const guide = within(note).getByRole("link", { name: "How to fix it" });
    expect(guide).toHaveAttribute("href", CALLS_BLOCKED_GUIDE);
    expect(guide).toHaveAttribute("target", "_blank");
    expect(CALLS_BLOCKED_GUIDE).toBe("https://github.com/MiguelMedeiros/ghostly/blob/main/docs/CALLS-BLOCKED.md");

    await view.user.click(within(note).getByRole("link", { name: "Network settings" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/network");
    expect(onClose).toHaveBeenCalledOnce();

    await view.user.click(within(note).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("is in every language", () => {
    renderApp(<CallNoPathNotice onClose={() => {}} />, { language: "pt" });
    const note = screen.getByRole("alert");
    expect(note).toHaveTextContent("A chamada não conectou");
    expect(within(note).getByRole("link", { name: "Ajustes de rede" })).toBeInTheDocument();
  });
});
