import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { useOutsideDismiss } from "../../hooks/useDismiss";

// covers: app.navigation.back

// A file of its own: what lib/layerHistory.ts watches is module state, and here no layer has been opened before the
// app's first move back (a fresh page: the tab bar's Chats from Settings, a chat's Back).

function ChatMenu({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideDismiss(ref, true, onClose);
  return <div ref={ref} data-testid="menu" />;
}

function Chat() {
  const nav = useAppNavigation();
  const [menu, setMenu] = useState(false);
  return (
    <>
      <button onClick={() => nav.home()}>Chats</button>
      <button onClick={() => setMenu(true)}>More</button>
      {menu && <ChatMenu onClose={() => setMenu(false)} />}
    </>
  );
}

function App() {
  const nav = useAppNavigation();
  return (
    <>
      <p data-testid="where">{useLocation().pathname}</p>
      <Routes>
        <Route path="/" element={<button onClick={() => nav.conversation("/chat/s1")}>Bob</button>} />
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </>
  );
}

const where = () => screen.getByTestId("where").textContent;
const layerEntry = () => typeof (history.state as Record<string, unknown> | null)?.ghostlyLayer === "number";

describe("Back with a layer open, after the app's own move back on a page that had no layer open yet", () => {
  it("closes the menu alone, at the first Back", async () => {
    history.replaceState(null, "", "#/");
    const user = userEvent.setup();
    render(<HashRouter><App /></HashRouter>);
    await user.click(screen.getByRole("button", { name: "Bob" }));
    await waitFor(() => expect(where()).toBe("/chat/s1"));
    // The app goes back to the list (a traversal of its own), then the chat is opened again.
    await user.click(screen.getByRole("button", { name: "Chats" }));
    await waitFor(() => expect(where()).toBe("/"));
    await user.click(screen.getByRole("button", { name: "Bob" }));
    await waitFor(() => expect(where()).toBe("/chat/s1"));

    await user.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(layerEntry()).toBe(true), { timeout: 3000 });
    await act(() => { history.back(); });
    await waitFor(() => expect(screen.queryByTestId("menu")).toBeNull());
    expect(where()).toBe("/chat/s1");
    expect(layerEntry()).toBe(false);
  });
});
