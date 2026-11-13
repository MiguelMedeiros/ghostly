import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes, useNavigate } from "react-router-dom";
import { App } from "../../App";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { renderApp } from "../render";

// covers: app.keyboard

/** A page's own control that opens another page: Back, or a Profile tile. It goes with the page it was on. */
function Leave({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>{label}</button>;
}

function renderPages() {
  return renderApp(
    <LockScreenProvider><UpdateProvider>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<p>Home</p>} />
          <Route path="/wallet" element={<section><Leave to="/" label="Back" /></section>} />
          <Route path="/profile" element={<><Leave to="/wallet" label="Open Wallets page" /><input aria-label="Name" /></>} />
        </Route>
      </Routes>
    </UpdateProvider></LockScreenProvider>,
    { route: "/profile" },
  );
}

/**
 * On a wide screen, a keyboard pressing a page's control that opens another page (Back, Profile's Wallets) took that
 * control away with its page, and the focus fell to the document: the next Tab started again at the top, past the
 * skip link and the whole chat list. The open page takes it, as the skip link gives it.
 */
describe("a page change that takes the focused control away", () => {
  it("gives the focus to the open page, not the document", () => {
    renderPages();
    const main = screen.getByRole("main");
    // At the start nothing moves: the first Tab goes to the skip link.
    expect(document.activeElement).toBe(document.body);

    const wallets = screen.getByRole("button", { name: "Open Wallets page" });
    wallets.focus();
    act(() => { fireEvent.click(wallets); });
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(document.activeElement).toBe(main);

    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    act(() => { fireEvent.click(back); });
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(document.activeElement).toBe(main);
  });

  it("leaves the focus on a control that is still there", () => {
    renderPages();
    // The account bar's Wallets stays on screen across the change: the focus stays on it.
    const bar = screen.getByTestId("wallet-chip");
    bar.focus();
    act(() => { fireEvent.click(bar); });
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(document.activeElement).toBe(bar);
  });
});
