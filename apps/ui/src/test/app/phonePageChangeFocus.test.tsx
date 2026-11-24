import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../render";

// covers: app.keyboard, app.mobile-layout

vi.mock("../../hooks/useIsMobile", () => ({ MOBILE_QUERY: "(max-width: 767px)", useIsMobile: () => true }));

/** A page's own control that opens another page: Back, or a Profile tile. It goes with the page it was on. */
function Leave({ to, label, testId }: { to: string; label: string; testId?: string }) {
  const navigate = useNavigate();
  return <button type="button" data-testid={testId} onClick={() => navigate(to)}>{label}</button>;
}

vi.mock("../../pages/Chat", () => ({ Chat: () => <Leave to="/" label="Back from chat" testId="chat-back" /> }));
vi.mock("../../components/Sidebar", () => ({
  Sidebar: () => (
    <nav>
      <button type="button" data-testid="sidebar-new-chat">New chat</button>
      <div data-testid="group-row" data-group="g2"><button type="button" data-testid="group-row-open">Other group</button></div>
      <div data-testid="chat-row" data-chat="s1"><button type="button" data-testid="chat-row-open">Alice</button></div>
      <div data-testid="group-row" data-group="g1"><button type="button" data-testid="group-row-open">Book club</button></div>
    </nav>
  ),
}));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));

/** A page that puts the focus in its own field as it opens. */
function Named() {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  return <><h1 tabIndex={-1}>Name</h1><input ref={field} aria-label="Name" /></>;
}

/** A page of the menu opened for the first time: nothing until its file is there (components/MenuPage.tsx). */
let drawLate: () => void = () => {};
function Late() {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => { drawLate = () => setDrawn(true); }, []);
  return drawn ? <h1 tabIndex={-1}>Wallets</h1> : null;
}

const { App } = await import("../../App");

function renderPages(route: string) {
  return renderApp(
    <Routes>
      <Route path="/" element={<App />}>
        <Route index element={null} />
        <Route path="chat/:sessionId" element={null} />
        <Route path="group/:groupId" element={<><Leave to="/" label="Back from group" testId="chat-back" /><Leave to="/" label="Leave group" /></>} />
        <Route path="profile" element={<><h1 tabIndex={-1}>Profile</h1><Leave to="/identities" label="Identities" /><Leave to="/" label="Chats" /><Leave to="/name" label="Name" /><Leave to="/wallet" label="Wallets" /></>} />
        <Route path="identities" element={<h1 tabIndex={-1}>Identities</h1>} />
        <Route path="name" element={<Named />} />
        <Route path="wallet" element={<Late />} />
      </Route>
    </Routes>,
    { route },
  );
}

function press(label: string) {
  const control = screen.getByRole("button", { name: label });
  control.focus();
  act(() => { fireEvent.click(control); });
}

/**
 * On a phone (one screen at a time), a keyboard pressing a control that opens another page (a chat's Back, Profile's
 * Identities) took that control away with its page, and the focus fell to the document: the next Tab started again at
 * the top, and a screen reader heard nothing of the page it was on. Back to the list, the conversation just left has it
 * (or New chat); any other page, its title, as a Settings section's on a phone.
 */
describe("a page change on a phone that takes the focused control away", () => {
  it("gives a chat's Back to that chat's row in the list", () => {
    renderPages("/chat/s1");
    press("Back from chat");
    expect(screen.getByTestId("chat-row-open")).toHaveFocus();
  });

  it("gives a group's Back to that group's row, not another group's", () => {
    renderPages("/group/g1");
    press("Back from group");
    expect(screen.getByRole("button", { name: "Book club" })).toHaveFocus();
  });

  it("gives Back to New chat when the conversation has no row", () => {
    renderPages("/group/gone");
    press("Back from group");
    expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus();
  });

  // Leave and Delete hand the focus past the group's row, which is going (GroupInvitation.tsx `focusPastRow`).
  it("leaves the list alone when a conversation's own control other than Back took it home", () => {
    renderPages("/group/g1");
    press("Leave group");
    expect(screen.getByRole("button", { name: "Book club" })).not.toHaveFocus();
    expect(screen.getByTestId("sidebar-new-chat")).not.toHaveFocus();
  });

  it("gives the page opened to its title", () => {
    renderPages("/profile");
    // At the start nothing moves.
    expect(document.activeElement).toBe(document.body);
    press("Identities");
    expect(screen.getByRole("heading", { name: "Identities" })).toHaveFocus();
  });

  it("gives a page drawn a moment later its title once it is there", async () => {
    renderPages("/profile");
    press("Wallets");
    expect(document.activeElement).toBe(document.body);
    act(() => drawLate());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Wallets" })).toHaveFocus());
  });

  it("leaves a page drawn a moment later alone when something took the focus meanwhile", async () => {
    renderPages("/profile");
    press("Wallets");
    const tab = document.createElement("button");
    document.body.append(tab);
    tab.focus();
    act(() => drawLate());
    await screen.findByRole("heading", { name: "Wallets" });
    await new Promise((r) => setTimeout(r, 20));
    expect(tab).toHaveFocus();
    tab.remove();
  });

  it("gives the list to New chat when no conversation was left", () => {
    renderPages("/profile");
    press("Chats");
    expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus();
  });

  it("leaves the focus where the page opened put it", () => {
    renderPages("/profile");
    press("Name");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });
});
