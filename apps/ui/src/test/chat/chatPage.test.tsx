import { act, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession, setStorageProfile, setStorageProfile as setProfile, getPrefix, addMessages } from "../../lib/storage";
import { problemText } from "../../lib/problemText";
import { translatorFor } from "../../locales";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { NotSent } from "@ghostly/browser/engine/outbox";
import { Profiler } from "react";
import type { ChatMessage } from "../../lib/types";
import { keepSentOriginal, sentOriginal } from "../../lib/sentOriginals";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {}, playCue: vi.fn() }));

/**
 * Cancel sending drops a message that waits: it is the engine that would send it, so the bubble goes once the engine
 * took the cancel. In limited mode the engine refuses it (nothing is withdrawn before the device check): the message
 * would still reach the contact, so the bubble stays, with the refusal under it, and the chat does not forget it.
 */
describe("Cancel sending a waiting message", () => {
  const PEER = "peer".padEnd(52, "p");
  const TEXT = "the door code is 4471";
  /** The engine's LIMITED_MODE_ERROR (packages/browser/src/engine/node.ts). */
  const LIMITED_MODE_ERROR = "Ghostly could not check which device is active yet. This works once it can.";
  afterEach(() => { localStorage.clear(); setStorageProfile(""); });

  function waitingChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000,
      messages: [{ id: "me_w1", ref: "w1", text: TEXT, sender: "me", timestamp: 1_700_000_000_500, delivery: "waiting" } as never] });
  }

  async function cancelSending(language: "en" | "pt", deleteMessage: () => { everyone: boolean }, limited: boolean) {
    waitingChat();
    const { user, engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language });
    engine.on("deleteMessage", deleteMessage)
      .update({ limited, settings: { online: true }, links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] } as never);
    await screen.findByText(TEXT);
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByTestId("message-cancel-sending"));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    return engine;
  }

  for (const language of ["en", "pt"] as const) {
    it(`refused in limited mode, the bubble stays and says why (${language})`, async () => {
      const engine = await cancelSending(language, () => { throw new Error(LIMITED_MODE_ERROR); }, true);
      expect(engine.callsTo("deleteMessage")).toEqual([{ linkId: "link-1", messageId: "me_w1" }]);
      expect(screen.getByText(TEXT)).toBeTruthy();
      const { title } = problemText(new Error(LIMITED_MODE_ERROR), translatorFor(language));
      expect(screen.getByTestId("message-retry-error").textContent).toContain(title);
      expect(loadSession("chat-1")?.deletedIds ?? []).toEqual([]);
    });
  }

  it("taken by the engine, the bubble goes", async () => {
    const engine = await cancelSending("en", () => ({ everyone: false }), false);
    expect(engine.callsTo("deleteMessage")).toEqual([{ linkId: "link-1", messageId: "me_w1" }]);
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(screen.queryByTestId("message-retry-error")).toBeNull();
    expect(loadSession("chat-1")?.deletedIds).toEqual(["me_w1"]);
  });
});

describe("the first text to an away contact, refused by every relay", () => {
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
    app.engine.on("deleteMessage", () => ({ everyone: false }))
      .update({ settings: { online: true }, links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] } as never);
    return app;
  }

  const row = (text: string) => screen.getByText(text).closest("[data-message-row]") as HTMLElement;

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

// The engine sends its whole state anew on every change (up to 20 a second while a file moves). An open chat, and one
// kept loaded off screen for the mini-app that runs in it (App.tsx), draw again only when what they show changes: a
// state that changes nothing of either draws neither.
describe("an engine state that changes nothing of a chat", () => {
  const ANA = "ana".padEnd(52, "a");
  const BIA = "bia".padEnd(52, "b");
  const START = 1_700_000_000_000;

  const history = (who: string): ChatMessage[] => Array.from({ length: 20 }, (_, i) => ({
    id: `${who}_${i}`, sender: "peer", timestamp: START + i * 60_000, text: `${who} ${i}`,
  } as ChatMessage));
  const settle = () => act(() => vi.advanceTimersByTimeAsync(50));

  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("draws neither the open chat nor one kept loaded behind it", async () => {
    const commits = { open: 0, kept: 0 };
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: ANA, encKeyB64: "a2V5", label: "Ana", messages: history("Ana"), createdAt: START });
    saveSession({ id: "chat-2", profile: "paired-chat/1", mySeedB64: "c2VlZB", peerPubKeyB64: BIA, encKeyB64: "a2V6", label: "Bia", messages: history("Bia"), createdAt: START });
    const { engine } = renderApp(
      <>
        <Profiler id="open" onRender={() => { commits.open++; }}>
          <Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />
        </Profiler>
        <div className="hidden">
          <Profiler id="kept" onRender={() => { commits.kept++; }}>
            <Chat sessionId="chat-2" visible={false} onCallChange={() => {}} callLayer={null} />
          </Profiler>
        </div>
      </>,
    );
    engine.on("ensureLink", (params) => ({ linkId: params.peerPubKeyZ32 === ANA ? "link-1" : "link-2" }))
      .on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    // Each state brings every link as a new object, as the engine's do.
    const links = (patch: Record<string, unknown> = {}) => [
      linkView({ id: "link-1", peerPubKeyZ32: ANA, profile: "paired-chat/1", pairing: { status: "ready" }, ...patch } as never),
      linkView({ id: "link-2", peerPubKeyZ32: BIA, profile: "paired-chat/1", pairing: { status: "ready" } } as never),
    ];
    engine.update({ links: links() });
    await screen.findByText("Ana 19");
    await settle();

    commits.open = commits.kept = 0;
    for (let i = 0; i < 20; i++) {
      act(() => engine.update({ links: links(), transfers: { [`t${i}`]: { bytes: i } } } as never));
      await settle();
    }
    expect(commits).toEqual({ open: 0, kept: 0 });

    // The open chat's own link changing still draws it, and only it.
    act(() => engine.update({ links: links({ status: "offline" }) }));
    await settle();
    expect(commits.open).toBeGreaterThan(0);
    expect(commits.kept).toBe(0);
  });
});

// covers: chat.paired.send
describe("an engine refusal in a 1:1 chat's composer, in Portuguese", () => {
  const PEER = "peer".padEnd(52, "p");

  /**
   * What a 1:1 chat's composer says when the engine refuses a send or an edit (engine/node.ts sendMessage, editMessage):
   * in the app's language, as a group's composer says it. The engine's English showed as it came, in every language.
   */
  function openChat(refusal: { send?: string; edit?: string }, messages: never[] = []) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages, createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
    utils.engine.on("sendMessage", async () => ({ error: refusal.send ?? null, refused: true }))
      .on("editMessage", async () => ({ error: refusal.edit ?? null, refused: true }))
      .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
    return utils;
  }

  afterEach(() => { localStorage.clear(); setProfile(""); });

  it.each([
    ["Message exceeds 16384 UTF-8 bytes.", "Mensagem longa demais. Encurte ou envie como arquivo."],
    ["Someone else joined with this invite first. Ask your contact for a new one.", "Outra pessoa entrou com este convite antes. Peça um novo ao seu contato."],
    ["You are offline", "Você está offline"],
    ["That message is not in this chat, or cannot be replied to", "Não dá para responder a essa mensagem. Cancele a resposta e envie de novo."],
  ])("a send refused with \"%s\" says it in the language", async (raw, said) => {
    const { user } = openChat({ send: raw });
    await user.click(await screen.findByPlaceholderText("Mensagem…"));
    await user.keyboard("olá{Enter}");
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(raw);
  });

  it.each([
    ["This message was edited 100 times, the most one takes.", "Esta mensagem não pode ser editada de novo. Uma mensagem aceita no máximo 100 edições."],
    ["Message exceeds 16384 UTF-8 bytes.", "Mensagem longa demais. Encurte ou envie como arquivo."],
  ])("an edit refused with \"%s\" says it in the language", async (raw, said) => {
    const { user, engine } = openChat({ edit: raw }, [{ id: "me_w1", ref: "w1", text: "first", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never]);
    const field = await screen.findByPlaceholderText("Mensagem…");
    await screen.findByText("first");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(field).toHaveValue("first"));
    await user.keyboard(" again{Enter}");
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(engine.callsTo("editMessage")).toHaveLength(1);
    expect(document.body.textContent).not.toContain(raw);
  });
});

// covers: chat.paired.send
describe("typing on while a message goes (a 1:1 chat)", () => {
  const PEER = "peer".padEnd(52, "p");

  /**
   * A 1:1 chat's composer stays open while a message goes. On a chat that is not live the engine answers only once the
   * DHT publication is done, seconds later; the field was disabled all that time, so what a fast typist wrote next,
   * and its Enter, went nowhere.
   */
  function openChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    const pending: (() => void)[] = [];
    utils.engine.on("sendMessage", () => new Promise((resolve) => { pending.push(() => resolve({ error: null })); }))
      .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] });
    const finish = async () => { await act(async () => { pending.shift()!(); }); };
    return { ...utils, pending, finish };
  }

  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
  const sentTexts = (engine: ReturnType<typeof openChat>["engine"]) => engine.callsTo("sendMessage").map((c) => (c as { text: string }).text);

  afterEach(() => { localStorage.clear(); setProfile(""); });

  it("the field stays open, and the next message typed with its Enter goes after the first", async () => {
    const { user, engine, pending, finish } = openChat();
    await user.click(await screen.findByPlaceholderText("Message…"));
    await user.keyboard("ok{Enter}");
    await waitFor(() => expect(pending).toHaveLength(1));
    // Still publishing: the field takes the next message.
    expect(field()).toBeEnabled();
    await user.keyboard("see you there{Enter}");
    // Each Enter is a message of its own: the words leave the field at once and wait for the first to go.
    expect(field()).toHaveValue("");
    expect(sentTexts(engine)).toEqual(["ok"]);
    await finish();
    await waitFor(() => expect(sentTexts(engine)).toEqual(["ok", "see you there"]));
    await finish();
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(field()).toHaveFocus();
  });

  it("words typed with no Enter stay in the field once the first has gone", async () => {
    const { user, engine, pending, finish } = openChat();
    await user.click(await screen.findByPlaceholderText("Message…"));
    await user.keyboard("ok{Enter}");
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.keyboard("and");
    await finish();
    await waitFor(() => expect(field()).toHaveValue("and"));
    expect(sentTexts(engine)).toEqual(["ok"]);
  });
});

// covers: chat.paired.delete-message
describe("Deleting a 1:1 message I sent translated", () => {
  /**
   * A 1:1 message I sent translated, deleted here or for everyone: what I typed goes with it (lib/sentOriginals.ts), as a
   * group message's does. The chat page's delete never forgot it, so the original stayed on this device.
   */
  const PEER = "peer".padEnd(52, "p");
  const ID = "me_w1";

  function openChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000,
      messages: [
        { id: ID, ref: "w1", text: "ciao a tutti", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never,
        { id: "me_w2", ref: "w2", text: "come stai", sender: "me", timestamp: 1_700_000_000_600, delivery: "delivered" } as never,
      ] });
    keepSentOriginal("chat-1", ID, { to: "it", original: "hello everyone" });
    keepSentOriginal("chat-1", "me_w2", { to: "it", original: "how are you" });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
    return utils;
  }

  const stored = () => localStorage.getItem(`${getPrefix()}sent_originals_chat-1`) ?? "";

  afterEach(() => { localStorage.clear(); setProfile(""); });

  it("here, forgets what I typed, and keeps the other message's", async () => {
    const { user } = openChat();
    const bubble = (await screen.findByText("ciao a tutti")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await waitFor(() => expect(screen.queryByText("ciao a tutti")).not.toBeInTheDocument());
    expect(sentOriginal("chat-1", ID)).toBeUndefined();
    expect(stored()).not.toContain("hello everyone");
    expect(sentOriginal("chat-1", "me_w2")).toEqual({ to: "it", original: "how are you" });
  });

  it("for everyone, forgets what I typed once the engine took the removal", async () => {
    const { user, engine } = openChat();
    engine.on("removeMessage", () => ({ error: null }));
    const bubble = (await screen.findByText("ciao a tutti")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete-everyone"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await waitFor(() => expect(engine.callsTo("removeMessage")).toHaveLength(1));
    await waitFor(() => expect(sentOriginal("chat-1", ID)).toBeUndefined());
    expect(stored()).not.toContain("hello everyone");
    expect(sentOriginal("chat-1", "me_w2")).toEqual({ to: "it", original: "how are you" });
  });
});

// covers: chat.order
/**
 * The timeline reads in the order things happened here (WISP 400, requirement 10). The engine places a received row
 * when it comes (`timestamp`) and keeps what the sender's clock said beside it (`sentAt`): the page sorts by the
 * place and shows the sender's time, never one later than the arrival. Reported with a contact's clock two minutes
 * ahead: its messages read "11:23 PM" at 11:21, and my replies sat above them.
 *
 * The mirror that writes the engine's rows into the chat's session is off in these tests (test/setup.ts): the rows
 * are added as it adds them (`addMessages`); packages/browser/test/platformSync.test.ts covers the mirror itself.
 */
describe("the timeline with a contact whose clock is off", () => {
  const PEER = "peer".padEnd(52, "p");
  const MINUTE = 60_000;
  /** 11:21 PM here. */
  const T = Date.now() - 10 * MINUTE;

  const mine = (text: string, at: number): ChatMessage => ({ id: `me_${at}`, sender: "me", text, timestamp: at, delivery: "delivered" });
  /** A contact's row as the engine stores it: placed when it came, with what the contact's clock said. */
  const theirs = (text: string, cameAt: number, skew: number): ChatMessage =>
    ({ id: `peer_${text}`, sender: "peer", text, timestamp: cameAt, sentAt: cameAt + skew });

  function openChat(messages: ChatMessage[]) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: T - MINUTE });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }

  const shownTexts = () => screen.getAllByTestId("message-text").map((el) => el.textContent);
  const shownTimes = () => screen.getAllByTestId("message-time").map((el) => Number(el.getAttribute("data-at")));

  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ["two minutes ahead", 2 * MINUTE],
    ["two minutes behind", -2 * MINUTE],
    ["three days ahead", 3 * 24 * 60 * MINUTE],
  ])("%s: messages read in the order they came, and none shows a time that has not come", async (_, skew) => {
    // I wrote, the contact answered twice, I replied, the contact answered again: each 20 seconds after the last.
    const step = 20_000;
    openChat([mine("are you there?", T), mine("good, see you then", T + 3 * step)]);
    await screen.findByText("good, see you then");
    act(() => {
      addMessages("chat-1", [theirs("yes", T + step, skew), theirs("just arrived", T + 2 * step, skew), theirs("see you", T + 4 * step, skew)]);
      window.dispatchEvent(new Event("session-updated"));
    });
    await screen.findByText("see you");

    expect(shownTexts()).toEqual(["are you there?", "yes", "just arrived", "good, see you then", "see you"]);
    // What the session keeps reads the same, for the next time the chat opens.
    expect(loadSession("chat-1")!.messages.map((m) => m.text)).toEqual(["are you there?", "yes", "just arrived", "good, see you then", "see you"]);
    const times = shownTimes();
    expect(times).toHaveLength(5);
    for (const at of times) expect(at).toBeLessThanOrEqual(Date.now());
    // The contact's bubbles show what its clock said, or when they came if that is earlier.
    const expected = (cameAt: number) => Math.min(cameAt + skew, cameAt);
    expect(times).toEqual([T, expected(T + step), expected(T + 2 * step), T + 3 * step, expected(T + 4 * step)]);
  });
});

// covers: chat.replies
describe("a reply to an older message, right after the app starts on a long chat", () => {
  const PEER = "peer".padEnd(52, "p"), WIRE = "A".repeat(22), OTHER = "B".repeat(22);

  it("does not say its original was deleted while the stored copy still leaves older messages out", async () => {
    // As a reload finds a long chat: its last rows only, the 4,800 older ones (the original among them) still in the engine.
    const reply: ChatMessage = { id: `peer_${OTHER}`, text: "still on?", sender: "peer", timestamp: 1_700_000_100_000,
      replyTo: { id: WIRE, snippet: "lunch at noon?", from: "me", messageId: `me_${WIRE}` } };
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [reply], older: 4_800, createdAt: 1_700_000_000_000 });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] });
    await screen.findByText("still on?");
    const quote = screen.getByTestId("message-quote");
    expect(quote).not.toHaveAttribute("data-state", "deleted");
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
  });
});
