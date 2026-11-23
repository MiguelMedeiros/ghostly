import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Button } from "../../components/wallet/ui";
import { renderApp } from "../render";

// covers: app.accessibility

/**
 * The shared Button kept its words on one line: on a phone at a larger text size a long label ("Load my profile and
 * follows", New identity's "Sign with Browser extension (NIP-07)") ran past the screen. Wider than its box, it wraps them;
 * it does not shrink beside its neighbours, so one that fits keeps its line (e2e/web/text-size.spec.ts measures it).
 */
it("a button's words wrap once it is as wide as its box, and it never shrinks for its neighbours", () => {
  renderApp(<Button data-testid="go">Sign with Browser extension (NIP-07)</Button>);
  const go = screen.getByTestId("go");
  expect(go).not.toHaveClass("whitespace-nowrap");
  expect(go).toHaveClass("max-w-full", "shrink-0", "break-words");
});
