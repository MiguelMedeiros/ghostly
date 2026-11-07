import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotSent } from "@ghostly/browser/engine/outbox";
import { Chat } from "../../pages/Chat";
import { saveSession, setStorageProfile } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {}, playCue: vi.fn() }));

const PEER = "peer".padEnd(52, "p");
const FIRST = "the first, no relay took it", SECOND = "the second, behind it";
afterEach(() => { localStorage.clear(); setStorageProfile(""); });

/**
 * The rows the engine stores for two texts to a contact away while every relay refuses what is published: the first's
 * publication went nowhere (`NotSent`), so it waits as the one after it does. `first`: the first's row, as the engine
 * stored it before (queued: sent once, not confirmed) or now.
 */
function chat(first: Record<string, unknown>) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000,
    messages: [
      { id: "me_f1", ref: "f1", text: FIRST, sender: "me", timestamp: 1_700_000_000_500, via: "datalink", ...first },
      { id: "me_f2", ref: "f2", text: SECOND, sender: "me", timestamp: 1_700_000_000_600, via: "datalink", delivery: "waiting", deliveryError: "Waits for the text before it to be confirmed." },
    ] as never });
  const app = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language: "en" });
  app.engine.on("deleteMessage", () => undefined)
    .update({ settings: { online: true }, links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] } as never);
  return app;
}

const row = (text: string) => screen.getByText(text).closest("[data-message-row]") as HTMLElement;

describe("the first text to an away contact, refused by every relay", () => {
  it("is marked and said as one that waits, and its ⋮ cancels it, as the text after it", async () => {
    const { user, engine } = chat({ delivery: "waiting", deliveryError: NotSent.REASON });
    await screen.findByText(FIRST);
    const mark = within(row(FIRST)).getByTestId("message-delivery");
    expect(mark).toHaveAttribute("data-delivery", "waiting");
    expect(mark).toHaveAccessibleName("Waiting for your contact to be online");
    await user.hover(mark);
    expect(within(row(FIRST)).getByTestId("message-delivery-tip")).toHaveTextContent("Sends by itself when your contact is online.");
    await user.unhover(mark);
    await user.click(within(row(FIRST)).getByTestId("message-options"));
    expect(screen.queryByTestId("message-delete-everyone")).toBeNull();
    await user.click(screen.getByTestId("message-cancel-sending"));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(engine.callsTo("deleteMessage")).toEqual([{ linkId: "link-1", messageId: "me_f1" }]);
    expect(screen.queryByText(FIRST)).toBeNull();
    // The one after it stays, still waiting to go.
    expect(within(row(SECOND)).getByTestId("message-delivery")).toHaveAttribute("data-delivery", "waiting");
  });

  it("one a relay may hold (it did not answer in time) stays queued, with no Cancel sending", async () => {
    const { user } = chat({ delivery: "queued", deliveryError: "DHT publication failed: Publish failed on every relay: Error: https://a.test did not answer. Bounded retry continues until expiry." });
    await screen.findByText(FIRST);
    expect(within(row(FIRST)).getByTestId("message-delivery")).toHaveAttribute("data-delivery", "queued");
    await user.click(within(row(FIRST)).getByTestId("message-options"));
    expect(screen.queryByTestId("message-cancel-sending")).toBeNull();
    expect(screen.getByTestId("message-delete")).toBeTruthy();
  });
});
