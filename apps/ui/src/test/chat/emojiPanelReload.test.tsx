import { afterEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "../render";
import { EmojiTab } from "../../components/composer/EmojiTab";

/**
 * The emoji data set's chunk does not load, and keeps not loading: Chromium keeps a failed import for as long as the
 * page lives, however good the connection is again. Once Try again failed, the panel offers Reload.
 */
vi.mock("@emoji-mart/data", () => { throw new TypeError("Failed to fetch dynamically imported module"); });

afterEach(() => { vi.restoreAllMocks(); });

it("once Try again failed, the emoji panel offers Reload, also when opened again, into a page the server answers for only", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  let reachable = false;
  const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => (reachable ? Promise.resolve(new Response(null, { status: 200 })) : Promise.reject(new TypeError("Failed to fetch"))));
  const { user, unmount } = renderApp(<EmojiTab onPick={() => {}} />);

  expect(await screen.findByText("The emoji could not be loaded.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

  await user.click(screen.getByTestId("emoji-retry"));
  const button = await screen.findByRole("button", { name: "Reload" });
  expect(screen.getByTestId("emoji-trouble")).toBeInTheDocument();

  // No connection: a reload would leave the browser's own error page, so the panel stays.
  await user.click(button);
  await waitFor(() => expect(fetched).toHaveBeenCalledWith(location.pathname, { method: "HEAD", cache: "no-store" }));
  await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
  expect(reload).not.toHaveBeenCalled();

  // The panel closed and opened again: still the failed file, still Reload.
  unmount();
  const again = renderApp(<EmojiTab onPick={() => {}} />);
  reachable = true;
  await again.user.click(await screen.findByRole("button", { name: "Reload" }));
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
});
