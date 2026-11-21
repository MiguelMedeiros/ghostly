import { screen, within, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatHoldDialog, ChatHoldLine } from "../../components/ChatHoldDialog";
import type { PeerHoldState, PeerLinkState } from "../../lib/platform";
import { renderApp } from "../render";

// covers: app.i18n
describe("the hold's problem, in the app's language", () => {
  /*
   * The hold's problem (WISP 404: picking up what the contact left, or storing what waits for them) under the chat and in
   * its dialog: a title and the next step in the app's language, and the storage's or the network's English behind the ⓘ.
   * Every one of them read in English, in every language, as the engine wrote it (2026-10-09).
   */

  const MB = 1024 * 1024;
  const hold = (error?: string): PeerHoldState => ({ enabled: true, peerAllows: true, storage: true, canHold: true, outstanding: 2, bytes: 1.5 * MB, maxBytes: 64 * MB, maxItems: 64, ttlMs: 7 * 86_400_000, refused: 0, ...(error && { error }) });
  const PICK_UP = "Could not pick up held items: The storage answered 403";

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

  it("items sealed for the device the profile was on before wait for the contact's app, not for a retry here", () => {
    renderApp(<ChatHoldLine hold={hold("Could not pick up held items: the contact's app sealed them for the device this profile was on before. They come once it seals them again for this one.")} name="Ana" />, { language: "pt" });
    expect(screen.getByTestId("hold-error")).toHaveTextContent("Seu contato deixou itens para o dispositivo que você usava antes" + "Eles chegam quando o app do seu contato os selar de novo para este.");
    expect(screen.queryByTestId("hold-error-info")).toBeNull();
  });

  it("items left waiting while Hide my IP is on say why, in one line", () => {
    renderApp(<ChatHoldLine hold={hold("Hide my IP from contacts is on: what your contact held for you waits on their storage until you turn it off.")} name="Ana" />, { language: "pt" });
    expect(screen.getByTestId("hold-error")).toHaveTextContent("Seu contato deixou itens para você no armazenamento dele" + "Ocultar meu IP está ligado, então eles esperam lá até você desligar.");
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

// covers: delivery.hold.enable
describe("a chat's hold dialog, Save", () => {
  /*
   * A chat's hold dialog: Save is busy while it saves, not disabled. A disabled button drops a keyboard's focus to the
   * page, and when the save is refused the dialog stays open with the focus on nothing, the next Tab from the top.
   */

  const MB = 1024 * 1024;
  const hold: PeerHoldState = { enabled: false, storage: true, canHold: true, outstanding: 0, bytes: 0, maxBytes: 64 * MB, maxItems: 64, ttlMs: 7 * 86_400_000, refused: 0 };
  const peer = { hold, dataLink: "open" } as PeerLinkState;

  it("keeps the focus while it saves, takes no second press, and keeps it when the save is refused", async () => {
    let refuse!: (error: Error) => void;
    const onSave = vi.fn(() => new Promise<void>((_, reject) => { refuse = reject; }));
    const onClose = vi.fn();
    const { user } = renderApp(<ChatHoldDialog peer={peer} name="Ana" onSave={onSave} onClose={onClose} />);
    await user.click(screen.getByTestId("chat-hold-toggle"));
    const save = screen.getByTestId("chat-hold-save");
    save.focus();
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledExactlyOnceWith(true);
    expect(save).toHaveFocus();
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save).toHaveTextContent("Saving");
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledTimes(1);
    // The switch takes no press while it saves either; Shift+Tab reaches it, Tab comes back to Save.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByTestId("chat-hold-toggle")).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByTestId("chat-hold-toggle")).toHaveAttribute("aria-checked", "true");
    await user.tab();
    await user.tab();
    expect(save).toHaveFocus();
    await act(async () => { refuse(new Error("The storage answered 403")); });
    expect(screen.getByRole("alert")).toHaveTextContent("403");
    expect(onClose).not.toHaveBeenCalled();
    expect(save).not.toHaveAttribute("aria-busy");
    expect(save).toHaveTextContent("Save");
    expect(save).toHaveFocus();
  });

  it("stays disabled until the switch changes", async () => {
    const { user } = renderApp(<ChatHoldDialog peer={peer} name="Ana" onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("chat-hold-save")).toBeDisabled();
    await user.click(screen.getByTestId("chat-hold-toggle"));
    expect(screen.getByTestId("chat-hold-save")).toBeEnabled();
  });
});
