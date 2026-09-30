import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { MessageBubble } from "../../components/MessageBubble";
import { previewText } from "../../lib/chatList";
import { transportLineText } from "../../lib/transportEvents";
import { BC1Q } from "../payments/moneyFormatFixtures";
import { translateWith } from "../../locales/translate";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { LOCALES, lookup } from "./locales";

// covers: app.i18n, transport.indicator

/** The chat's connection panel, call lines and transport lines were English in every language before 1.0.1. */
describe("the chat's connection and call lines, in the app's language", () => {
  it("names the connection icon and its panel in Portuguese", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language: "pt" });
    act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1", "iroh/1"], textDelivery: "dht", dataLink: "idle",
      peerParticipationKey: "saved", peerNick: "Bea", pairing: { status: "connecting" } as LinkView["pairing"] })] }));
    const state = lookup("pt", "connection.state.onDht")!;
    expect(state).not.toBe(lookup("en", "connection.state.onDht"));
    const icon = screen.getByTestId("connection-options");
    expect(icon).toHaveAttribute("aria-label", lookup("pt", "connection.panel.titleWith")!.replace("{{label}}", state));
    await view.user.click(icon);
    expect(screen.getByTestId("connection-state")).toHaveTextContent(state);
    expect(screen.getByTestId("connection-details-summary")).toHaveTextContent(lookup("pt", "connection.panel.details")!);
    // The choices: Automatic and DHT only, in Portuguese too; transport names stay as they are.
    const options = within(screen.getByTestId("transport-options"));
    expect(options.getByTestId("connection-option-auto")).toHaveAccessibleName(lookup("pt", "connection.option.automatic")!);
    expect(options.getByTestId("connection-option-dht")).toHaveAccessibleName(lookup("pt", "connection.dhtOnly")!);
    expect(options.getByTestId("connection-option-iroh")).toHaveAccessibleName("Iroh");
  });

  it("words a call line from its kind in Arabic, whatever English the history kept", () => {
    renderApp(<MessageBubble message={{ id: "c1", text: "Missed video call", sender: "system", timestamp: 0, callEvent: { type: "call_missed", hasVideo: true } }} />,
      { language: "ar" });
    const line = lookup("ar", "calls.timeline.videoMissed")!;
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText("Missed video call")).toBeNull();
  });

  it.each(["pt", "ar"] as const)("says a video call could not connect in %s, whatever English the history kept", (language) => {
    renderApp(<MessageBubble message={{ id: "c2", text: "Video call couldn't connect", sender: "system", timestamp: 0, callEvent: { type: "call_failed", hasVideo: true } }} />,
      { language });
    expect(screen.getByText(lookup(language, "calls.timeline.videoFailed")!)).toBeInTheDocument();
    expect(screen.queryByText("Video call couldn't connect")).toBeNull();
  });

  it.each(["pt", "ja"] as const)("says our video call was not answered in %s, whatever English the history kept", (language) => {
    renderApp(<MessageBubble message={{ id: "c3", text: "Video call not answered", sender: "system", timestamp: 0, callEvent: { type: "call_unanswered", hasVideo: true } }} />,
      { language });
    expect(screen.getByText(lookup(language, "calls.timeline.videoUnanswered")!)).toBeInTheDocument();
    expect(screen.queryByText("Video call not answered")).toBeNull();
  });

  it("says what a pasted address is in the chat list, in the language it is handed, English kept apart", () => {
    const pt = translateWith(LOCALES.pt);
    expect(previewText(BC1Q, pt)).toBe(`${lookup("pt", "chat.preview.bitcoinAddress")} · ${lookup("pt", "chat.preview.realMoney")}`);
    // The previews are kept per language: English is still English after Portuguese.
    expect(previewText(BC1Q)).toBe("₿ Bitcoin address · Real money");
  });

  it("puts a transport line in the language it is handed, the contact's name and the transport in place", () => {
    const t = translateWith(LOCALES.pt);
    expect(transportLineText({ id: "x", at: 0, kind: "switched", cause: "contact", from: "webrtc/1", transport: "iroh/1" }, "Ana", t))
      .toBe(lookup("pt", "connection.line.contactSwitched")!.replace("{{contact}}", "Ana").replace("{{transport}}", "Iroh"));
  });
});
