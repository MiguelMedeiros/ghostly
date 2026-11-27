import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { Route, Routes, useNavigate, useParams, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../render";
import { focusPastRow, rowAfter } from "../../components/GroupInvitation";

// covers: app.keyboard, app.mobile-layout

let mobile = true;
vi.mock("../../hooks/useIsMobile", () => ({ MOBILE_QUERY: "(max-width: 767px)", useIsMobile: () => mobile }));

/** A page's own control that opens another page: Back, or a Profile tile. It goes with the page it was on. */
function Leave({ to, label, testId }: { to: string; label: string; testId?: string }) {
  const navigate = useNavigate();
  return <button type="button" data-testid={testId} onClick={() => navigate(to)}>{label}</button>;
}

/**
 * A group's other ways home (Leave, Delete, Cancel joining): the group's row is going, so they hand the focus on past
 * it themselves, once the list shows (GroupInvitation.tsx `focusPastRow`).
 */
function GoneHome({ groupId, label }: { groupId: string; label: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => { const next = rowAfter(groupId), pressed = document.activeElement; void navigate("/"); focusPastRow(next, pressed); }}>{label}</button>;
}

/** A chat draws its own title; "bob" is on a call, so it stays loaded, hidden, once its Their profile is pressed. */
vi.mock("../../pages/Chat", () => ({
  Chat: ({ sessionId, onCallChange }: { sessionId: string; onCallChange: (id: string, onCall: boolean) => void }) => {
    useEffect(() => { if (sessionId === "bob") onCallChange(sessionId, true); }, [sessionId, onCallChange]);
    return (
      <>
        <h1 tabIndex={-1}>Chat {sessionId}</h1>
        <p tabIndex={0}>A message in {sessionId}</p>
        <textarea aria-label={`Message to ${sessionId}`} />
        <Leave to="/" label="Back from chat" testId="chat-back" /><Leave to="/profile" label="Their profile" />
      </>
    );
  },
}));
vi.mock("../../components/Sidebar", () => ({
  Sidebar: () => (
    <nav>
      <button type="button" data-testid="sidebar-new-chat">New chat</button>
      <div data-testid="group-row" data-group="g2"><button type="button" data-testid="group-row-open">Other group</button></div>
      <div data-testid="chat-row" data-chat="s1"><button type="button" data-testid="chat-row-open">Alice</button></div>
      <div data-testid="group-row" data-group="g1"><button type="button" data-testid="group-row-open">Book club</button></div>
      <div hidden><div data-testid="chat-row" data-chat="s9"><button type="button" data-testid="chat-row-open">Filtered out</button></div></div>
    </nav>
  ),
}));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));

/** The app's own way to a page, with no control pressed. */
let go: NavigateFunction = () => {};
function Go() {
  const navigate = useNavigate();
  useEffect(() => { go = navigate; }, [navigate]);
  return null;
}

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

/** A group's page: its title, Back, and its other ways home. */
function Group() {
  const groupId = useParams().groupId!;
  return (
    <>
      <h1 tabIndex={-1}>Group {groupId}</h1>
      <Leave to="/" label="Back from group" testId="chat-back" />
      <GoneHome groupId={groupId} label="Leave group" />
      <GoneHome groupId={groupId} label="Delete group" />
      <GoneHome groupId={groupId} label="Cancel joining" />
    </>
  );
}

const { App } = await import("../../App");

function renderPages(route: string) {
  return renderApp(
    <>
      {/* Out of the pages: the chat list shows none. */}
      <Go />
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={null} />
          <Route path="chat/:sessionId" element={null} />
          <Route path="group/:groupId" element={<Group />} />
          <Route path="profile" element={<><h1 tabIndex={-1}>Profile</h1><Leave to="/identities" label="Identities" /><Leave to="/" label="Chats" /><Leave to="/name" label="Name" /><Leave to="/wallet" label="Wallets" /><Leave to="/chat/s1" label="Message" /></>} />
          <Route path="identities" element={<h1 tabIndex={-1}>Identities</h1>} />
          <Route path="name" element={<Named />} />
          <Route path="wallet" element={<Late />} />
        </Route>
      </Routes>
    </>,
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
  // Stylesheets are left out of these tests: a chat kept loaded off screen is `hidden`, so it hides here.
  let sheet: HTMLStyleElement;
  beforeEach(() => {
    sheet = document.createElement("style");
    sheet.textContent = ".hidden { display: none; }";
    document.head.append(sheet);
  });
  afterEach(() => { sheet.remove(); });

  it("gives a chat's Back to that chat's row in the list", () => {
    renderPages("/chat/s1");
    press("Back from chat");
    expect(screen.getByRole("button", { name: "Alice" })).toHaveFocus();
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

  // Leave, Delete and Cancel joining hand the focus past the group's row, which is going (GroupInvitation.tsx
  // `focusPastRow`): Other group's next row is Alice's.
  it.each(["Leave group", "Delete group", "Cancel joining"])("leaves %s to hand the focus past the group's row", async (label) => {
    // As a browser does, and happy-dom does not: no focus in the list while it is hidden behind the page.
    const focus = HTMLElement.prototype.focus;
    const shown = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (!this.closest(".hidden")) focus.call(this, options);
    });
    try {
      renderPages("/group/g2");
      press(label);
      expect(screen.getByRole("button", { name: "Other group" })).not.toHaveFocus();
      expect(screen.getByTestId("sidebar-new-chat")).not.toHaveFocus();
      await waitFor(() => expect(screen.getByRole("button", { name: "Alice" })).toHaveFocus());
    } finally { shown.mockRestore(); }
  });

  it("gives the page opened to its title", () => {
    renderPages("/profile");
    // At the start nothing moves.
    expect(document.activeElement).toBe(document.body);
    press("Identities");
    expect(screen.getByRole("heading", { name: "Identities" })).toHaveFocus();
  });

  it("gives Back to New chat when the conversation's row is not shown", () => {
    renderPages("/chat/s9");
    press("Back from chat");
    expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus();
  });

  it("gives the page opened its own title, not that of a chat kept loaded for its call", async () => {
    renderPages("/chat/bob");
    await act(async () => {});
    press("Their profile");
    expect(screen.getByRole("heading", { name: "Chat bob", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Profile" })).toHaveFocus();
  });

  it("leaves a chat opened to put the focus where it wants it", () => {
    renderPages("/profile");
    press("Message");
    expect(document.activeElement).toBe(document.body);
  });

  it("gives a page drawn a moment later its title once it is there", async () => {
    renderPages("/profile");
    press("Wallets");
    expect(document.activeElement).toBe(document.body);
    // Later than right away: the watch lasts a while.
    await new Promise((r) => setTimeout(r, 30));
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

  it("stops waiting for a page's title once another page is open", async () => {
    renderPages("/profile");
    press("Wallets");
    act(() => go("/"));
    (document.activeElement as HTMLElement).blur();
    const title = document.createElement("h1");
    title.tabIndex = -1;
    act(() => { document.querySelector("main")!.append(title); });
    await new Promise((r) => setTimeout(r, 20));
    expect(title).not.toHaveFocus();
    title.remove();
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

  /** Opens `path` from the chat list, puts the focus on `focused` in it, then goes back as the browser or the system does. */
  function backFrom(path: string, focused: () => HTMLElement) {
    renderPages("/");
    act(() => { void go(path); });
    focused().focus();
    act(() => { void go(-1); });
  }

  // The browser's Back, or the system's (Android's back gesture), with no control of the page pressed: the focus was
  // last on whatever had it in the conversation, gone with it.
  it.each([
    ["its title", () => screen.getByRole("heading", { name: "Chat s1" })],
    ["its message field", () => screen.getByRole("textbox", { name: "Message to s1" })],
    ["a message", () => screen.getByText("A message in s1")],
  ])("gives the browser's or the system's Back from a chat, with the focus on %s, to that chat's row", (_, focused) => {
    backFrom("/chat/s1", focused);
    expect(screen.getByRole("button", { name: "Alice" })).toHaveFocus();
  });

  it("gives the browser's or the system's Back from a group to that group's row", () => {
    backFrom("/group/g1", () => screen.getByRole("heading", { name: "Group g1" }));
    expect(screen.getByRole("button", { name: "Book club" })).toHaveFocus();
  });

  it("gives the browser's or the system's Back to New chat when the conversation's row is not shown", () => {
    backFrom("/chat/s9", () => screen.getByRole("heading", { name: "Chat s9" }));
    expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus();
  });

  // Gone from the list: deleted (Chat.tsx goes home after), or left.
  it("leaves the list alone when the conversation left has no row any more", () => {
    backFrom("/chat/gone", () => screen.getByRole("heading", { name: "Chat gone" }));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves the focus where the person put it out of the conversation", () => {
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    try {
      backFrom("/chat/s1", () => elsewhere);
      expect(elsewhere).toHaveFocus();
      // And once that is gone too, the row is not handed a focus that was never in the conversation.
      act(() => { void go("/chat/s1"); });
      elsewhere.focus();
      elsewhere.remove();
      act(() => { void go(-1); });
      expect(screen.getByRole("button", { name: "Alice" })).not.toHaveFocus();
    } finally { elsewhere.remove(); }
  });

  it("leaves two panes as they were: the focus goes to the open page's column", () => {
    mobile = false;
    try {
      backFrom("/chat/s1", () => screen.getByRole("heading", { name: "Chat s1" }));
      expect(document.activeElement).toBe(document.querySelector("main"));
    } finally { mobile = true; }
  });
});
