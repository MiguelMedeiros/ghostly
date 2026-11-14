import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { ChatSubtitle } from "../../components/TypingIndicator";
import { usePeerTyping } from "../../hooks/useTyping";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
// covers: extension.reconnecting

/**
 * An extension tab whose peer went away and did not come back at once (the Reconnecting notice): the contact's typing is
 * the last thing the tab was told, and the peer that ends it after its timeout is the one gone. The header said
 * "typing…" until the peer was back, however long that took.
 */
afterEach(async () => {
  fakeEngine.refuse = null;
  await engine.connect();
});

const PEER = "peer".padEnd(52, "p");

async function losePeer() {
  fakeEngine.refuse = new Error("The offscreen document did not start");
  act(() => fakeEngine.drop());
  await waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
}
async function back() {
  fakeEngine.refuse = null;
  await waitFor(() => expect(engine.reconnecting).toBe(false), { timeout: 3000 });
}

function Typing() {
  return <span data-testid="typing-flag">{String(usePeerTyping(PEER))}</span>;
}

describe("the contact's typing while the tab lost its peer", () => {
  it("is not said until the peer is back", async () => {
    const view = renderApp(<div>
      <ChatSubtitle peerKey={PEER} keyLabel="ABCD" />
      <Typing />
    </div>);
    act(() => view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", peerTyping: true, peerTypingKind: "recording" })] }));
    expect(screen.getByTestId("chat-typing")).toHaveAttribute("data-kind", "recording");
    expect(screen.getByTestId("typing-flag")).toHaveTextContent("true");

    await losePeer();
    expect(screen.queryByTestId("chat-typing")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-subtitle")).toHaveTextContent("ABCD");
    expect(screen.getByTestId("typing-flag")).toHaveTextContent("false");

    await back();
    expect(screen.getByTestId("chat-typing")).toHaveAttribute("data-kind", "recording");
  });
});
