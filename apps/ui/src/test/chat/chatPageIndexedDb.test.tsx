import "fake-indexeddb/auto";
import { screen, act, within, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession, saveInviteCode } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import type { ChatSession } from "../../lib/types";
import { installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {}, playCue: vi.fn() }));

// covers: chats.list.rename, app.keyboard
/**
 * A 1:1 chat's name in its header is the only way to rename the chat. It was a clickable line of text: Tab never
 * reached it, a screen reader read it as text, and after Enter or Escape the focus fell to the page.
 */
describe("a chat's name in its header", () => {
  const PEER = "peer".padEnd(52, "p");

  function openChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }

  it("is a button the keyboard reaches, and Enter opens the field with the name in it", async () => {
    const { user } = openChat();
    const name = await screen.findByRole("button", { name: "Ana" });
    expect(name).toContainElement(screen.getByTestId("chat-name"));
    name.focus();
    expect(document.activeElement).toBe(name);
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    expect(field).toHaveValue("Ana");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("gives the focus back to the name after Enter saves it", async () => {
    const { user } = openChat();
    (await screen.findByRole("button", { name: "Ana" })).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await user.clear(field);
    await user.type(field, "Bea{Enter}");
    const name = await screen.findByRole("button", { name: "Bea" });
    expect(document.activeElement).toBe(name);
    expect(loadSession("chat-1")?.label).toBe("Bea");
  });

  it("gives the focus back to the name after Escape, and keeps the name it had", async () => {
    const { user } = openChat();
    (await screen.findByRole("button", { name: "Ana" })).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await user.type(field, "x{Escape}");
    const name = await screen.findByRole("button", { name: "Ana" });
    expect(document.activeElement).toBe(name);
    expect(loadSession("chat-1")?.label).toBe("Ana");
  });

  it("spends the Escape that cancels it: a notice at the top that also answers Escape stays", async () => {
    const { user } = openChat();
    (await screen.findByRole("button", { name: "Ana" })).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    // What the "No room for a new chat" notice hears (Root.tsx): an Escape on the window, closed only when not spent.
    const heard: boolean[] = [];
    const notice = (e: KeyboardEvent) => { if (e.key === "Escape") heard.push(e.defaultPrevented); };
    window.addEventListener("keydown", notice);
    try {
      await user.type(field, "x{Escape}");
    } finally { window.removeEventListener("keydown", notice); }
    expect(heard).toEqual([true]);
    expect(await screen.findByRole("button", { name: "Ana" })).toBeInTheDocument();
  });
});

// covers: chat.paired.pairing-progress, invite.code
describe("a chat made here, opened before the engine has its link", () => {
  it("asks the engine for the link with its invite code, whoever asks first: the engine learns who invited from it", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peer".padEnd(52, "p"), encKeyB64: "a2V5", participationSeedB64: "cGFydA", messages: [], createdAt: Date.now() });
    saveInviteCode("chat-1", "ghostly1-invite");
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined);
    await act(async () => {});
    const asked = engine.callsTo("ensureLink") as { inviteCode?: string }[];
    expect(asked.length).toBeGreaterThan(0);
    // Without it the engine would make the link the joiner's, and the inviter's scene would look the invite up.
    expect(asked.map(params => params.inviteCode)).toEqual(asked.map(() => "ghostly1-invite"));
  });
});

// covers: chat.one-chat
describe("a paired chat stopped by a contact-key mismatch", () => {
  const key = "a".repeat(52);
  // pairedSession.ts's words for the stop: the engine's, in English.
  const ENGINE = "Saved contact key mismatch. This invite is already paired with another participation key. Check with your contact and use a new invitation if the change was intended.";

  beforeEach(() => { installFakeMedia(); });
  afterEach(() => { removeFakeMedia(); });

  it("says why the files, media and voice cannot go in the app's language, never the engine's English", async () => {
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: key, encKeyB64: "enc", messages: [], createdAt: 1_700_000_000_000, nick: "Ana", nickSource: "profile" } as ChatSession);
    const utils = renderApp(<Chat sessionId="a" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: key, profile: "paired-chat/1", peerParticipationKey: "saved",
      pairing: { status: "error", peerKey: "other", keyMismatch: true, error: ENGINE } } as never)] });

    await vi.waitFor(() => expect(screen.getByTestId("voice-record")).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByTestId("voice-record")).toHaveAttribute("title", "Esta conversa parou: a chave do seu contato mudou.");
    expect(document.body.innerHTML).not.toContain("Saved contact key mismatch");
  });
});

// covers: chat.ratchet.ui
describe("a chat's Tech Info", () => {
  const PEER = "peer".padEnd(52, "p");

  /** A paired chat whose DHT floor says this of forward secrecy (WISP 4xx), its Tech Info open. */
  async function techInfo(forwardSecrecy?: "on" | "starting" | "unsupported" | "stopped") {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Casper", messages: [], createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" },
      dhtDelivery: { mode: "stream", authenticated: true, maxTextBytes: 256, ...(forwardSecrecy && { forwardSecrecy }) } } as never)] });
    await utils.user.click(await screen.findByTestId("chat-options"));
    await utils.user.click(screen.getByTestId("chat-tech-info"));
    return utils;
  }

  describe("a chat's Tech Info says whether forward secrecy is on", () => {
    it("On, with why behind ⓘ, and that a live connection has fresh keys anyway", async () => {
      const { user } = await techInfo("on");
      const row = screen.getByTestId("tech-forward-secrecy");
      expect(row).toHaveTextContent("Forward secrecy");
      expect(row).toHaveTextContent("On");
      expect(row).not.toHaveTextContent("stolen");
      await user.click(within(row).getByTestId("tech-forward-secrecy-info"));
      expect(row).toHaveTextContent("a key stolen later cannot open them");
      expect(row).toHaveTextContent("A live connection always uses fresh keys.");
    });

    for (const [state, why] of [["starting", "turns on once you have both written"], ["unsupported", "does not support it yet"], ["stopped", "no longer supports it"]] as const) {
      it(`Off while ${state}, and its ⓘ says why`, async () => {
        const { user } = await techInfo(state);
        const row = screen.getByTestId("tech-forward-secrecy");
        expect(row).toHaveAttribute("data-state", state);
        expect(row).toHaveTextContent("Off");
        await user.click(within(row).getByTestId("tech-forward-secrecy-info"));
        expect(row).toHaveTextContent(why);
      });
    }

    it("has no row where the engine says nothing of it (an app or chat without the ratchet)", async () => {
      await techInfo();
      expect(screen.getByRole("heading", { name: "Tech Info" })).toBeInTheDocument();
      expect(screen.queryByTestId("tech-forward-secrecy")).not.toBeInTheDocument();
    });
  });

  describe("a chat's Tech Info on a phone", () => {
    it("has its values that copy a thumb's height, at least 24 px", async () => {
      // The session id's row was 230 x 16 px on a phone on its side.
      await techInfo("on");
      // The session id and both keys (the connection panel's keys have the same title).
      const copies = screen.getAllByTitle("Click to copy");
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies) expect(copy.className.split(/\s+/)).toContain("max-md:min-h-6");
    });
  });
});

// covers: files.large.offer, files.large.limits
// happy-dom has no IndexedDB: the file store keeps what is sent in this one.
describe("a file the contact cannot take is refused in the app's language", () => {
  const PEER ="peer".padEnd(52, "p");

  /** A paired chat in Portuguese, live, with a contact whose app is described by `link`. */
  function openChat(link: Record<string, unknown>) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
    utils.engine.on("sendFile", () => undefined)
      .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", ...link } as never)] });
    return utils;
  }

  /** A file that says it is `size` bytes, without holding them. */
  function fileOf(size: number) {
    const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
    Object.defineProperty(file, "size", { value: size });
    return file;
  }

  it("a files/3 contact without room for it: the translated title and how much is free", async () => {
    const { engine } = openChat({ capabilities: { files: true, largeFiles: true }, peerFileRoom: 2_000_000 });
    fireEvent.change(await screen.findByTestId("file-input"), { target: { files: [fileOf(5_000_000)] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Sem espaço no dispositivo do contato\. .+ livres\./);
    expect(alert).not.toHaveTextContent("Not enough space");
    expect(engine.callsTo("sendFile")).toHaveLength(0);
  });

  it("an older contact's app, past its limit: the translated title and its maximum", async () => {
    const { engine } = openChat({ capabilities: { files: true } });
    fireEvent.change(await screen.findByTestId("file-input"), { target: { files: [fileOf(2 ** 40)] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Grande demais para o app do contato\. Máx\. .+ até ele atualizar o Ghostly\./);
    expect(engine.callsTo("sendFile")).toHaveLength(0);
  });
});
