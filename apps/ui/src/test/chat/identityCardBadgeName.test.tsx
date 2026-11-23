import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { ensureSession, updateSessionLabel } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { receivedView } from "../identities/views";
import { renderApp } from "../render";

// covers: chat.cards.identity

/*
 * An identity card's badge names the contact who proved it ("Proved by ~Ana"). The name is their own words: its own
 * <bdi>, or in Arabic "~Bob!" read "!Bob~", its punctuation taking the sentence's direction.
 */

const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("an identity card's badge", () => {
  it.each([["ar"], ["en"]] as const)("keeps the contact's name in its own direction (%s)", async (language) => {
    const chat = ensureSession({ seedB64: "s", peerPubKeyB64: "peer", encKeyB64: "k" });
    updateSessionLabel(chat, "Bob!");
    const { engine } = renderApp(<MessageBubble message={{ id: "m1", text: DID_KEY, sender: "peer", timestamp: 1_700_000_000_000 }} peerNick="Bob!" peerPubKey="peer" />, { language });
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: "peer", identities: { support: true, shared: [], received: [receivedView({ provider: "did", subject: DID_KEY })] } })] }));
    await waitFor(() => expect(screen.getByTestId("entity-identity")).toHaveAttribute("data-standing", "verified"));
    const badge = screen.getByTestId("entity-identity-badge");
    expect([...badge.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual(["~Bob!"]);
    if (language === "en") expect(badge).toHaveTextContent("Proved by ~Bob!");
  });
});
