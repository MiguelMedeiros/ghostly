import { screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { loadEmoji, setSkinTone } from "../../lib/emoji";
import { renderApp } from "../render";

// covers: app.composer.expressions, app.emoji-picker, chat.reactions

/**
 * The skin-tone row is a layer inside the emoji panel (the composer's and a message's reaction +). Choosing a tone
 * with the keyboard unmounted the row under the focused radio, so the focus fell to the page's body with the panel
 * still open; and Escape in the row closed the whole panel. Now the focus goes back to the tone button, and Escape
 * closes only the row.
 */

beforeAll(() => loadEmoji());
afterEach(() => { setSkinTone(0); vi.restoreAllMocks(); });

type Opened = { user: ReturnType<typeof renderApp>["user"]; panel: () => HTMLElement | null };

/** The composer's emoji panel, opened from the keyboard. */
async function composerPanel(): Promise<Opened> {
  const { user } = renderApp(<LockScreenProvider><MessageInput onSend={vi.fn(async () => null)} onSendFile={vi.fn(async () => null)} identities={{ peerKey: "peer", contact: "Alice" }} /></LockScreenProvider>);
  screen.getByTestId("composer-expressions").focus();
  await user.keyboard("{Enter}");
  return { user, panel: () => screen.queryByTestId("expression-panel") };
}

/** A message's reaction + picker, opened from the keyboard. */
async function reactionPanel(): Promise<Opened> {
  const message = { id: `peer_${"A".repeat(22)}`, text: "lunch at noon?", sender: "peer" as const, timestamp: 1_700_000_000_000 };
  const { user } = renderApp(<MessageBubble message={message} peerPubKey="peer" onReact={vi.fn()} reactionName={(by) => by} />);
  screen.getByTestId("message-react-action").focus();
  await user.keyboard("{Enter}");
  screen.getByTestId("reaction-more").focus();
  await user.keyboard("{Enter}");
  return { user, panel: () => screen.queryByTestId("reaction-picker") };
}

/** The tone row opened from its button with Enter, the focus Tabbed into it. */
async function openTones({ user }: Opened) {
  const skin = screen.getByTestId("emoji-skin");
  skin.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByTestId("emoji-skins")).toBeInTheDocument();
  await user.tab();
  expect(screen.getByTestId("emoji-skin-0")).toHaveFocus();
  return skin;
}

describe.each([["the composer's emoji panel", composerPanel], ["a message's reaction picker", reactionPanel]])("the skin tones in %s", (_, open) => {
  it("a tone chosen with Enter gives the focus back to the tone button, not the page, and the panel stays", async () => {
    const opened = await open();
    const skin = await openTones(opened);
    await opened.user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("emoji-skin-1")).toHaveFocus();
    await opened.user.keyboard("{Enter}");
    expect(screen.queryByTestId("emoji-skins")).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(skin).toHaveFocus();
    expect(skin).toHaveTextContent("✋🏻");
    expect(opened.panel()).toBeInTheDocument();
  });

  it("Escape in the tone row closes only the row, the focus back on its button; the next Escape closes the panel", async () => {
    const opened = await open();
    const skin = await openTones(opened);
    await opened.user.keyboard("{Escape}");
    expect(screen.queryByTestId("emoji-skins")).not.toBeInTheDocument();
    expect(opened.panel()).toBeInTheDocument();
    expect(skin).toHaveFocus();
    expect(skin).toHaveAttribute("aria-expanded", "false");
    await opened.user.keyboard("{Escape}");
    expect(opened.panel()).not.toBeInTheDocument();
  });

  it("Escape on the tone button while its row is open closes only the row", async () => {
    const opened = await open();
    const skin = screen.getByTestId("emoji-skin");
    skin.focus();
    await opened.user.keyboard("{Enter}");
    expect(screen.getByTestId("emoji-skins")).toBeInTheDocument();
    await opened.user.keyboard("{Escape}");
    expect(screen.queryByTestId("emoji-skins")).not.toBeInTheDocument();
    expect(opened.panel()).toBeInTheDocument();
    expect(skin).toHaveFocus();
  });
});
