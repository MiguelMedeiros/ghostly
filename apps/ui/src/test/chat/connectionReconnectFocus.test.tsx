import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.reconnect

type Pairing = NonNullable<LinkView["pairing"]>;
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];
const away: Partial<LinkView> = { dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" };
const live: Partial<LinkView> = { dataLink: "open", peerOnline: true, peerParticipationKey: "saved", pairing: { status: "ready", transport: "webrtc/1", peerKey: "peer" } as Pairing };

/** The chat with a contact who is away, its connection panel open. */
async function openAway(outside = false) {
  const view = renderApp(<><ChatConnection peerKey="peer" />{outside && <button type="button">Elsewhere</button>}</>);
  act(() => view.engine.update({ links: [linkView({ availableTransports: all, ...away })] }));
  await view.user.click(screen.getByTestId("connection-options"));
  return { ...view, goLive: () => act(() => view.engine.update({ links: [linkView({ availableTransports: all, ...live })] })) };
}

/**
 * Reconnect is there only while the chat is not live. When the contact came back with the focus on it (just pressed,
 * or tabbed to), it went from under the focus, which fell to the page: a screen reader lost its place, and Tab started
 * again from the top. The panel's state line, which then says the chat is live, takes it instead.
 */
describe("the connection panel, when the chat goes live under Reconnect", () => {
  it("moves the focus from Reconnect to the state line, which says the chat is live", async () => {
    const { goLive } = await openAway();
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    reconnect.focus();
    goLive();
    expect(reconnect).not.toBeInTheDocument();
    const state = screen.getByTestId("connection-state");
    expect(document.body).not.toHaveFocus();
    expect(state).toHaveFocus();
    expect(state).toHaveTextContent("Connected · WebRTC");
    expect(state).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the focus on Reconnect while it dials, then gives it to the state line once live", async () => {
    const { user, engine, goLive } = await openAway();
    let answer: () => void = () => {};
    engine.on("connect", () => new Promise<void>((resolve) => { answer = resolve; }));
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    await user.click(reconnect);
    expect(reconnect).toHaveTextContent("Reconnecting…");
    expect(reconnect).toHaveFocus();
    goLive();
    await act(async () => answer());
    expect(screen.getByTestId("connection-state")).toHaveFocus();
  });

  it("leaves the focus alone when it was elsewhere in the panel", async () => {
    const { goLive } = await openAway();
    const details = screen.getByTestId("connection-details-summary");
    details.focus();
    goLive();
    expect(details).toHaveFocus();
  });

  it("leaves the focus alone when it was outside the panel", async () => {
    const { goLive } = await openAway(true);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    goLive();
    expect(elsewhere).toHaveFocus();
  });

  it("still closes on Escape from the state line, handing the focus back to the header", async () => {
    const { user, goLive } = await openAway();
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    screen.getByRole("button", { name: "Reconnect" }).focus();
    goLive();
    expect(screen.getByTestId("connection-state")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(menu.open).toBe(false);
    expect(screen.getByTestId("connection-options")).toHaveFocus();
  });
});
