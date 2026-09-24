# Component tests

Tests for the shared UI (`src/`) and the hooks in `packages/react`, with Vitest, Testing Library and
happy-dom. `npm run test:ui` runs them alone; `npm test` runs them after the packages' own tests, and CI
runs `npm test`. Config: `vitest.ui.config.ts`.

They render the UI as the **web app** builds it: `ghostlyPlatformModules()` swaps `src/lib/platform.ts` and
the other platform modules for the browser peer's (`packages/browser/src/platform/`), exactly as
`web/vite.config.ts` does. That peer's `engine` connects to `fakeEngine`, a `BrowserHost` the test scripts:
no engine, network, IndexedDB or Tauri is involved.

| File | What it gives a test |
| --- | --- |
| `setup.ts` | jest-dom matchers; before each test, empty `localStorage` and a reset fake engine; `cleanup` after. |
| `fakeEngine.ts` | `fakeEngine`: `setState(patch)` / `update(patch)` push a new engine state to the UI; `on(method, handler)` answers a call; `calls` / `callsTo(method)` show what the UI asked. A call nobody answers **fails**, like an engine error, so a test never passes on a silent no-op. Builders: `engineState`, `linkView`, `paymentView`, `groupView`, `walletView`. |
| `render.tsx` | `renderApp(ui, { route, language })`: renders inside the router, settings and translations, and returns Testing Library's queries, a `user` (user-event) and `engine` (the fake). |

```tsx
import { screen } from "@testing-library/react";
import { linkView } from "../test/fakeEngine";
import { renderApp } from "../test/render";

it("reconnects from the connection menu", async () => {
  const { user, engine } = renderApp(<PairingBanner peerKey="peer" />);
  engine.on("connect", () => undefined).update({ links: [linkView({ pairing: { status: "error", error: "Relay refused" } })] });
  await user.click(screen.getByTestId("connection-options"));
  await user.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(engine.callsTo("connect")).toEqual([{ linkId: "link-1" }]);
});
```

What they are for: what a component says and does for a given state — labels, which buttons are enabled,
what a click asks the engine, validation messages. Not layout, CSS or animation: happy-dom has no layout
(sizes are 0, container queries do not apply), so anything about how the UI looks stays in the Playwright
suites (`e2e/`).
