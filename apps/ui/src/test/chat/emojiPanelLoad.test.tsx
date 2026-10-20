import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "../render";
import { EmojiTab } from "../../components/composer/EmojiTab";
import { loadEmoji } from "../../lib/emoji";

/**
 * The emoji panel loads its data set the first time it shows (it is not part of the first screen). While it comes the
 * panel is empty and busy; a load that fails says so with "Try again", which loads it.
 */
vi.mock("../../lib/emoji", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/emoji")>();
  return { ...actual, loadEmoji: vi.fn(actual.loadEmoji) };
});

describe("the emoji panel", () => {
  it("shows the emoji once its data set loads, and offers Try again when the load fails", async () => {
    vi.mocked(loadEmoji).mockRejectedValueOnce(new Error("offline"));
    const onPick = vi.fn();
    const { user } = renderApp(<EmojiTab onPick={onPick} />);
    expect(await screen.findByText("The emoji could not be loaded.")).toBeTruthy();
    expect(screen.queryByTestId("emoji-grid")).toBeNull();

    await user.click(screen.getByTestId("emoji-retry"));
    await waitFor(() => expect(screen.getByTestId("emoji-grid").querySelector("[data-emoji]")).not.toBeNull());
    expect(screen.queryByTestId("emoji-trouble")).toBeNull();
    await user.click(screen.getByRole("button", { name: "😀" }));
    expect(onPick).toHaveBeenCalledWith("😀");
  });
});
