import { screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALLS_BLOCKED_GUIDE, CallNoPathNotice } from "../../components/CallNoPathNotice";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: calls.no-path

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

afterEach(() => vi.restoreAllMocks());

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

  // Closed from the keyboard, the note went with its focused × and the focus fell to the page.
  it("closed from the keyboard, gives the focus to the chat's ⋮", async () => {
    function Chat() {
      const options = useRef<HTMLButtonElement>(null);
      const [shown, setShown] = useState(true);
      return <><button ref={options} data-testid="chat-options">⋮</button>{shown && <CallNoPathNotice returnFocus={options} onClose={() => setShown(false)} />}<textarea data-testid="composer" /></>;
    }
    const { user } = renderApp(<Chat />);
    screen.getByRole("button", { name: "Close" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("chat-options")).toHaveFocus();
  });

  it("with a TURN server set, says the call did not get through it either and what to check, not to add one", () => {
    const turn = [{ urls: "stun:stun.example.org:3478, turn:turn.example.org:3478", username: "ghostly", credential: "x" }];
    renderApp(<CallNoPathNotice iceServers={turn} onClose={() => {}} />);
    const note = screen.getByRole("alert");
    expect(note).toHaveTextContent("The call couldn't connect");
    expect(note).toHaveTextContent("It didn't get through your TURN server either. Check its address (TURN over TLS on 443) and credential, or your contact may need one too.");
    expect(note).not.toHaveTextContent("A TURN server gets them through.");
    expect(within(note).getByRole("link", { name: "Network settings" })).toBeInTheDocument();
    expect(within(note).getByRole("link", { name: "How to fix it" })).toHaveAttribute("href", CALLS_BLOCKED_GUIDE);
  });

  it("counts a TURN server with its credential left out (a restored backup), and not a STUN server alone", () => {
    const { unmount } = renderApp(<CallNoPathNotice iceServers={[{ urls: "turns:turn.example.org:443?transport=tcp", username: "ghostly" }]} onClose={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("It didn't get through your TURN server either.");
    unmount();
    renderApp(<CallNoPathNotice iceServers={[{ urls: "stun:stun.example.org:3478" }]} onClose={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("A TURN server gets them through.");
  });

  it("gives its links a 44 px hit area, as its ×, without making them look any bigger", () => {
    renderApp(<CallNoPathNotice onClose={() => {}} />);
    const note = screen.getByRole("alert");
    for (const name of ["Network settings", "How to fix it"])
      expect(within(note).getByRole("link", { name })).toHaveClass("relative", "before:absolute", "before:-inset-y-3");
    expect(within(note).getByRole("button", { name: "Close" })).toHaveClass("before:-inset-3");
  });

  it("is in every language", () => {
    renderApp(<CallNoPathNotice onClose={() => {}} />, { language: "pt" });
    const note = screen.getByRole("alert");
    expect(note).toHaveTextContent("A chamada não conectou");
    expect(within(note).getByRole("link", { name: "Ajustes de rede" })).toBeInTheDocument();
  });

  // A phone's Network screen has its relay lists above the TURN server: at 375×667 the field started below the fold.
  it.each([[true, "en"], [true, "ar"], [false, "en"], [false, "ar"]] as const)("Network settings opens Network at the TURN server field (phone: %s, %s)", async (phone, language) => {
    windowIs(phone);
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { scrolled.push(this); });
    const { user } = renderApp(
      <LockScreenProvider><UpdateProvider>
        <Routes>
          <Route path="/chat/:id" element={<CallNoPathNotice onClose={() => {}} />} />
          <Route path="/settings/:section?" element={<Settings />} />
        </Routes>
      </UpdateProvider></LockScreenProvider>, { route: "/chat/abc", language });
    await user.click(screen.getByTestId("call-no-path-settings"));
    const field = await screen.findByTestId("network-turn-field");
    await vi.waitFor(() => expect(scrolled[scrolled.length - 1]).toBe(field));
  });

  it("says the TURN server case in every language", () => {
    renderApp(<CallNoPathNotice iceServers={[{ urls: "turn:turn.example.org:3478", username: "u", credential: "c" }]} onClose={() => {}} />, { language: "pt" });
    expect(screen.getByRole("alert")).toHaveTextContent("Ela também não passou pelo seu servidor TURN.");
  });
});
