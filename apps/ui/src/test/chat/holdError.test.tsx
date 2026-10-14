import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatHoldDialog, ChatHoldLine } from "../../components/ChatHoldDialog";
import type { PeerHoldState, PeerLinkState } from "../../lib/platform";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * The hold's problem (WISP 404: picking up what the contact left, or storing what waits for them) under the chat and in
 * its dialog: a title and the next step in the app's language, and the storage's or the network's English behind the ⓘ.
 * Every one of them read in English, in every language, as the engine wrote it (2026-10-09).
 */

const MB = 1024 * 1024;
const hold = (error?: string): PeerHoldState => ({ enabled: true, peerAllows: true, storage: true, canHold: true, outstanding: 2, bytes: 1.5 * MB, maxBytes: 64 * MB, maxItems: 64, ttlMs: 7 * 86_400_000, refused: 0, ...(error && { error }) });
const PICK_UP = "Could not pick up held items: The storage answered 403";

describe("the hold's problem, in the app's language", () => {
  it("in the dialog: a title and the next step, the storage's answer behind the ⓘ", async () => {
    const { user } = renderApp(<ChatHoldDialog peer={{ hold: hold(PICK_UP) } as PeerLinkState} name="Ana" onSave={vi.fn()} onClose={vi.fn()} />, { language: "pt" });
    const error = screen.getByTestId("chat-hold-error");
    expect(screen.getByTestId("chat-hold-error-title")).toHaveTextContent("Não foi possível buscar o que seu contato deixou para você");
    expect(screen.getByTestId("chat-hold-error-next")).toHaveTextContent("O Ghostly tenta de novo sozinho.");
    expect(error).not.toHaveTextContent(/storage|403|Could not/);
    await user.click(screen.getByTestId("chat-hold-error-info"));
    expect(screen.getByTestId("chat-hold-error-details")).toHaveTextContent(PICK_UP);
  });

  it("under the chat: what is held, then the problem, with its ⓘ", async () => {
    const { user } = renderApp(<ChatHoldLine hold={hold("Could not read the contact's pointer: Failed to fetch")} name="Ana" />, { language: "pt" });
    const line = screen.getByTestId("hold-indicator");
    expect(line).toHaveTextContent("2 itens guardados para Ana");
    expect(within(line).getByTestId("hold-error-title")).toHaveTextContent("Não foi possível ver o que seu contato deixou para você");
    expect(line).not.toHaveTextContent(/pointer|Failed to fetch/);
    await user.click(within(line).getByTestId("hold-error-info"));
    expect(within(line).getByTestId("hold-error-details")).toHaveTextContent("Could not read the contact's pointer: Failed to fetch");
  });

  it("a line with nothing more to say has no ⓘ", () => {
    renderApp(<ChatHoldLine hold={hold("The contact holds items for you, but their address expired. They are handed out again when the contact is next online.")} name="Ana" />, { language: "pt" });
    expect(screen.getByTestId("hold-error")).toHaveTextContent("Seu contato deixou itens para você, mas o endereço deles expirou" + "Eles chegam quando seu contato voltar a ficar online.");
    expect(screen.queryByTestId("hold-error-info")).toBeNull();
  });

  it("is not there without a problem, and the line not without anything held either", () => {
    const { rerender } = renderApp(<ChatHoldLine hold={hold()} name="Ana" />);
    expect(screen.getByTestId("hold-indicator")).toHaveTextContent("2 items held for Ana");
    expect(screen.queryByTestId("hold-error")).toBeNull();
    rerender(<ChatHoldLine hold={{ ...hold(), outstanding: 0 }} name="Ana" />);
    expect(screen.queryByTestId("hold-indicator")).toBeNull();
  });
});
