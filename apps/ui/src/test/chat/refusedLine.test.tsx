import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { formatAmount } from "../../lib/amount";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { renderApp } from "../render";
import { lookup } from "../i18n/locales";

// covers: app.i18n, chats.list.rows

/*
 * agents#2252: the line this app writes when it refuses a contact's payment ("Could not receive 21 sats: …") showed in
 * English in every language, on the contact's side as a message of theirs, and said "sats" for test sats. It is the
 * app's own line now, said from the values the engine stores with it; a line stored before them is read from its English.
 */

const REASON = "Ecash from 127.0.0.1 is not accepted";
/** As the engine writes it now (shared/refusals.ts `refusedRow`), mirrored by sync.ts. */
const refused: ChatMessage = {
  id: "peer_7_refused", text: `Could not receive 21 test sats: ${REASON}`, sender: "system", timestamp: 7,
  notice: { type: "paymentRefused", amount: 21, network: "testnet", reason: REASON },
};
/** As every version before stored it, and a session mirrored then still holds it: the contact's row, English text. */
const older: ChatMessage = { id: "peer_8_refused", text: `Could not receive 21 sats: ${REASON}`, sender: "peer", timestamp: 8 };

const said = (language: "ar" | "pt" | "ja", key: string, amount = 21) => lookup(language, `chat.refused.${key}`)!
  .replace("{{amount}}", formatAmount(amount, language))
  .replace("{{reason}}", lookup(language, "errors.cashu.mintNotAccepted")!.replace("{{host}}", "127.0.0.1"));

describe("a payment this app refused, in the chat", () => {
  it("is the app's own line in Arabic, in test sats, with the reason translated", () => {
    renderApp(<MessageBubble message={refused} />, { language: "ar" });
    const line = screen.getByTestId("refused-line");
    expect(line).toHaveTextContent(said("ar", "testSats"));
    expect(line.textContent).toContain("ساتس تجريبية");
    expect(screen.queryByText(/Could not receive/)).toBeNull();
    // Centred as the app's lines are, never a bubble on the contact's side.
    expect(line.closest("[data-message-row]")).toHaveAttribute("data-sender", "system");
    expect(document.querySelector('[data-sender="peer"]')).toBeNull();
  });

  it("reads a line stored in English before, still under the contact's name, as the app's line in Portuguese", () => {
    renderApp(<MessageBubble message={older} />, { language: "pt" });
    const line = screen.getByTestId("refused-line");
    expect(line).toHaveTextContent(said("pt", "sats"));
    expect(line.closest("[data-message-row]")).toHaveAttribute("data-sender", "system");
  });

  it("leaves a contact's own message that says the same words as their message", () => {
    renderApp(<MessageBubble message={{ ...older, id: "peer_9" }} />, { language: "pt" });
    expect(screen.queryByTestId("refused-line")).toBeNull();
    expect(screen.getByText(older.text)).toBeInTheDocument();
  });

  it("says Fedimint's in its words, and a refusal before any amount was read", () => {
    const fedimint: ChatMessage = { id: "peer_10_refused", text: "Could not receive Fedimint ecash: These notes were already redeemed", sender: "system", timestamp: 10,
      notice: { type: "paymentRefused", amount: 5, network: "testnet", method: "fedimint", reason: "These notes were already redeemed" } };
    renderApp(<MessageBubble message={fedimint} />, { language: "ja" });
    expect(screen.getByTestId("refused-line")).toHaveTextContent(lookup("ja", "chat.refused.testSatsFedimint")!
      .replace("{{amount}}", formatAmount(5, "ja")).replace("{{reason}}", lookup("ja", "errors.pay.notesRedeemed")!));
  });

  it("is the chat list's last line in the app's language, not the stored English", () => {
    const key = "k".repeat(52);
    const session: ChatSession = { id: "c", profile: "paired-chat/1", mySeedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc", nick: "Cleo", nickSource: "profile",
      messages: [{ id: "m1", text: "here you go", sender: "peer", timestamp: 1 }, refused], createdAt: 0 };
    saveSession(session);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "ja" });
    const row = screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Cleo")!;
    expect(row).toHaveTextContent(said("ja", "testSats"));
    expect(row.textContent).not.toContain("Could not receive");
  });
});
