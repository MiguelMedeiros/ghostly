import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.chat-switch

type Pairing = NonNullable<LinkView["pairing"]>;
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];
const live = (patch: Partial<LinkView> = {}) => linkView({ availableTransports: all, transportAutomatic: false, preferredTransport: "webrtc/1",
  pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open", ...patch });
const reason = "Hang up the call to use DHT only";

/**
 * DHT only closes the live link, and a call's hang-up crosses it: chosen during a call, the call talked on over its
 * own connection and neither side could hang it up (the contact's ended only when its media stalled out). So DHT only
 * is off while a call is on in that chat, with the reason on screen, and back once the call ends.
 */
describe("the connection panel's DHT only during a call", () => {
  it("is off with the reason while a call is on in the chat, and chooses nothing", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" callOn />);
    act(() => engine.update({ links: [live()] }));
    await user.click(screen.getByTestId("connection-options"));
    const dht = screen.getByTestId("connection-option-dht");
    expect(dht).toBeDisabled();
    expect(dht).toHaveAccessibleDescription(reason);
    // On screen at every width, not only in a tooltip.
    expect(within(dht).getByText(reason)).not.toHaveClass("md:hidden");
    await user.click(dht);
    expect(engine.callsTo("setChatTransport")).toEqual([]);
    // The other choices stay.
    expect(screen.getByTestId("connection-option-iroh")).toBeEnabled();
    expect(screen.getByTestId("connection-option-auto")).toBeEnabled();
  });

  it("is on with no call, and comes back when the call ends", async () => {
    const { user, engine, rerender } = renderApp(<ChatConnection peerKey="peer" callOn />);
    act(() => engine.update({ links: [live()] }));
    await user.click(screen.getByTestId("connection-options"));
    expect(screen.getByTestId("connection-option-dht")).toBeDisabled();
    rerender(<ChatConnection peerKey="peer" callOn={false} />);
    const dht = screen.getByTestId("connection-option-dht");
    expect(dht).toBeEnabled();
    expect(dht).not.toHaveAccessibleDescription(reason);
    await user.click(dht);
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
  });

  it("is on in a chat beside the one with the call", async () => {
    const { user, engine } = renderApp(<>
      <ChatConnection peerKey="peer" callOn />
      <ChatConnection peerKey="other" testIdPrefix="b-" />
    </>);
    act(() => engine.update({ links: [live(), live({ id: "link-2", peerPubKeyZ32: "other" })] }));
    await user.click(screen.getByTestId("b-connection-options"));
    const panel = screen.getByTestId("b-connection-menu");
    expect(within(panel).getByTestId("connection-option-dht")).toBeEnabled();
    await user.click(within(panel).getByTestId("connection-option-dht"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-2", transport: "dht" }]);
  });

  it("is skipped by the arrow keys, and a call coming in while it has the focus leaves the focus in the group", async () => {
    const { user, engine, rerender } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [live()] }));
    await user.click(screen.getByTestId("connection-options"));
    const dht = screen.getByTestId("connection-option-dht");
    dht.focus();
    rerender(<ChatConnection peerKey="peer" callOn />);
    expect(dht).toBeDisabled();
    // The group's Tab stop, the transport chosen, has it: never the page.
    const webrtc = screen.getByTestId("connection-option-webrtc");
    expect(webrtc).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByTestId("connection-option-hyperdht")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("connection-option-auto")).toHaveFocus();
  });
});
