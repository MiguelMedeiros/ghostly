import { render, screen } from "@testing-library/react";
import { memo, useSyncExternalStore } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { it } from "vitest";
import { AppRouter } from "../../Root";

// covers: app.navigation

/**
 * Going to another chat is drawn at once, whatever else the page is doing (Miguel, 2026-09-28: switching chats lagged,
 * and leaving a long chat took seconds on a slow machine). The engine's state comes several times a second, each time a
 * sync render; a move drawn as a transition started over at each one, and waited behind the long chat's older rows.
 */

it("draws the chat moved to while the engine's state keeps coming", { timeout: 20_000 }, async () => {
  // Real timers and React's own scheduler: the draws are interrupted, or not, as in the app.
  const act = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasAct = act.IS_REACT_ACT_ENVIRONMENT;
  act.IS_REACT_ACT_ENVIRONMENT = false;
  const store = { n: 0, listeners: new Set<() => void>() };
  const subscribe = (listener: () => void) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; };
  // A chat's page takes a while to draw on a slow machine: longer than the time between two changes of the state.
  const Row = memo(function Row({ id }: { id: string }) {
    const end = performance.now() + 1;
    while (performance.now() < end) { /* drawing */ }
    return <p>{id}</p>;
  });
  function Page({ name }: { name: string }) {
    // Every page reads the engine's state, as the chat page does.
    useSyncExternalStore(subscribe, () => store.n);
    const navigate = useNavigate();
    return (
      <div data-testid={name}>
        {/* As a chat's row in the chat list. */}
        <button type="button" onClick={() => navigate("/chat/b")}>Bea</button>
        {Array.from({ length: 300 }, (_, i) => <Row key={i} id={`${name} ${i}`} />)}
      </div>
    );
  }
  window.location.hash = "#/chat/a";
  const { unmount } = render(
    <AppRouter>
      <Routes>
        <Route path="/chat/a" element={<Page name="a" />} />
        <Route path="/chat/b" element={<Page name="b" />} />
      </Routes>
    </AppRouter>,
  );
  await screen.findByTestId("a", undefined, { timeout: 10_000 });
  const timer = setInterval(() => { store.n++; for (const listener of store.listeners) listener(); }, 30);
  try {
    // A plain click: `fireEvent` would draw everything at once, in `act`.
    screen.getByRole("button", { name: "Bea" }).click();
    // Drawn as a transition it came only when React gave up on waiting, 5 s later, however fast the machine.
    await screen.findByTestId("b", undefined, { timeout: 4_000 });
  } finally {
    clearInterval(timer);
    unmount();
    window.location.hash = "";
    act.IS_REACT_ACT_ENVIRONMENT = wasAct;
  }
});
