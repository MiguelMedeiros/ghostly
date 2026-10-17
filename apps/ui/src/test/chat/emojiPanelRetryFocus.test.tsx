import { expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "../render";
import { EmojiTab } from "../../components/composer/EmojiTab";

/**
 * Try again pressed from the keyboard, and the emoji data set's chunk still does not load: the focus stays on
 * Try again while it loads and after it failed again, next to the Reload that now shows, not on the page.
 */
vi.mock("@emoji-mart/data", () => { throw new TypeError("Failed to fetch dynamically imported module"); });

it("keeps the focus on Try again while it loads and once it failed again", async () => {
  const { user } = renderApp(<EmojiTab onPick={() => {}} />);
  const retry = await screen.findByTestId("emoji-retry");
  retry.focus();

  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByTestId("emoji-retry"));
  await screen.findByRole("button", { name: "Reload" });
  expect(document.activeElement).toBe(screen.getByTestId("emoji-retry"));

  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByTestId("emoji-retry"));
  await waitFor(() => expect(screen.getByTestId("emoji-tab")).not.toHaveAttribute("aria-busy"));
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  expect(document.activeElement).toBe(screen.getByTestId("emoji-retry"));
});
