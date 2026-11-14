import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { renderApp } from "../render";

// covers: chat.paired.message-details, app.i18n

/**
 * Message details shows the message under its title, after its kind ("نص" in Arabic). The kind and the text shared one
 * `dir="auto"` line, so the kind chose the line's direction: in the Arabic app "hello world 42!" read "!hello world 42",
 * and in the English one an Arabic text's question mark went to its wrong end. The text is laid out in its own
 * direction, as its bubble does; the kind follows the app's.
 */
async function excerpt(text: string, language: "ar" | "en") {
  const { container, user } = renderApp(<MessageBubble message={{ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000 }} peerPubKey="peer" />, { language });
  await user.keyboard("{Control>}");
  await user.dblClick(container.querySelector("[data-message-bubble]")!);
  await user.keyboard("{/Control}");
  return within(await screen.findByTestId("message-details")).getByTestId("message-details-excerpt");
}

describe("Message details: the message's text keeps its own direction", () => {
  it.each([
    ["an English text in the Arabic app", "hello world 42!", "ar"],
    ["an Arabic text in the English app", "مرحبا يا صديقي؟", "en"],
  ] as const)("%s", async (_, text, language) => {
    const shown = await excerpt(text, language);
    const words = within(shown).getByText(text);
    expect(words).toHaveAttribute("dir", "auto");
    // Nothing of the app's own words shares the text's line: the kind is outside it.
    expect(words).not.toContainElement(within(shown).getByTestId("message-details-kind"));
    expect(shown).not.toHaveAttribute("dir");
  });
});
