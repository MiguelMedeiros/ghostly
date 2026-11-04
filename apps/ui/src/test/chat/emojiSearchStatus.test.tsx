import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "../render";
import { EmojiTab } from "../../components/composer/EmojiTab";

// covers: app.emoji-picker

/**
 * The emoji search (the composer's panel, a reaction's +) says what it found once the typing settles: how many emoji,
 * or that none matched. A screen reader heard only its own letters, and Tabbed into a grid that was not there.
 */
describe("the emoji search's status", () => {
  it("says how many emoji a settled query found, and when none matched, not on each keystroke", async () => {
    const { user } = renderApp(<EmojiTab onPick={() => {}} />);
    const search = await screen.findByPlaceholderText("Search emoji");
    const status = screen.getByTestId("emoji-found");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("");

    await user.type(search, "heart");
    expect(status).toHaveTextContent("");
    await waitFor(() => expect(status.textContent).toMatch(/^\d+ emoji$/));
    const cells = screen.getByTestId("emoji-grid").querySelectorAll("[data-emoji]").length;
    expect(status).toHaveTextContent(`${cells} emoji`);

    await user.clear(search);
    await user.type(search, "zzqqxx");
    await waitFor(() => expect(status).toHaveTextContent("No emoji found"));

    await user.clear(search);
    await waitFor(() => expect(status).toHaveTextContent(""));
  });

  it("says it in the app's language, with its plural forms", async () => {
    const { user } = renderApp(<EmojiTab onPick={() => {}} />, { language: "pt" });
    await user.type(await screen.findByPlaceholderText("Pesquisar emoji"), "zzqqxx");
    await waitFor(() => expect(screen.getByTestId("emoji-found")).toHaveTextContent("Nenhum emoji encontrado"));
  });
});
