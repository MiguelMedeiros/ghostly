import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { MessageBubble } from "../../components/MessageBubble";
import { ForwardDialog, NameList } from "../../components/chat/ForwardDialog";
import { LOCALES } from "../i18n/locales";
import { translateWith } from "../../locales/translate";
import { useForwarding } from "../../hooks/useForwarding";
import { canForward, forwardSecret } from "../../lib/forward";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { engineState, fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { axeViolations } from "../axe";

// covers: chat.forward

/** An old message (no entry animation) from the contact, unless the patch says otherwise. */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000, ...patch });
const PICTURE = { id: "link-1-in-p", name: "ghost.png", size: 12, mime: "image/png" };
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function chat(id: string, peer: string, nick: string, last: number) {
  saveSession({ id, mySeedB64: "s", peerPubKeyB64: peer, encKeyB64: "e", nick, createdAt: 1, messages: [{ id: "x", text: "hi", sender: "peer", timestamp: last }] } as unknown as ChatSession);
}

beforeEach(() => {
  chat("chat-ana", "peer-ana", "Ana", 3_000);
  chat("chat-bo", "peer-bo", "Bo", 1_000);
  fakeEngine.setState(engineState({
    links: [linkView({ id: "link-ana", peerPubKeyZ32: "peer-ana" }), linkView({ id: "link-bo", peerPubKeyZ32: "peer-bo" })],
    groups: [groupView({ id: "g1", name: "Friends", lastMessageAt: 2_000 }), groupView({ id: "g2", name: "Readers", canSend: false })],
  }));
});

describe("which messages have Forward", () => {
  it("texts and files, not payments, call lines or notices", () => {
    expect(canForward(message())).toBe(true);
    expect(canForward(message({ text: "", file: PICTURE }))).toBe(true);
    expect(canForward(message({ paymentId: "pay-1" }))).toBe(false);
    expect(canForward(message({ sender: "system", callEvent: { type: "call_missed" } }))).toBe(false);
    expect(canForward(message({ sender: "system", systemEvent: { type: "join" } }))).toBe(false);
  });

  it("the ⋮ says Forward and Select for a text; a message without them has neither", async () => {
    const { user } = renderApp(<><MessageBubble message={message()} peerPubKey="peer" onForward={() => {}} onSelect={() => {}} />
      <MessageBubble message={message({ id: "m2", paymentId: "pay-1" })} peerPubKey="peer" /></>);
    const [text, payment] = screen.getAllByTestId("message-options");
    await user.click(text!);
    expect(screen.getByTestId("message-forward")).toHaveTextContent("Forward");
    expect(screen.getByTestId("message-select-start")).toHaveTextContent("Select");
    await user.keyboard("{Escape}");
    await user.click(payment!);
    expect(screen.queryByTestId("message-forward")).toBeNull();
    expect(screen.queryByTestId("message-select-start")).toBeNull();
  });

  it("a file still arriving has Forward greyed, with the reason", async () => {
    fakeEngine.update({ transfers: { [PICTURE.id]: { state: "transferring", transferred: 4, size: 12 } } });
    const { user } = renderApp(<MessageBubble message={message({ text: "", file: PICTURE })} peerPubKey="peer" onForward={() => {}} />);
    await user.click(screen.getByTestId("message-options"));
    expect(screen.getByTestId("message-forward")).toBeDisabled();
    expect(screen.getByTestId("message-forward")).toHaveTextContent("Not received yet");
  });
});

describe("the Forwarded label", () => {
  it("says Forwarded, and Forwarded many times from five hops, never from whom", () => {
    renderApp(<><MessageBubble message={message({ forwarded: 1 })} peerPubKey="peer" />
      <MessageBubble message={message({ id: "m2", forwarded: 5 })} peerPubKey="peer" />
      <MessageBubble message={message({ id: "m3" })} peerPubKey="peer" /></>);
    const labels = screen.getAllByTestId("message-forwarded");
    expect(labels.map(l => l.textContent)).toEqual(["Forwarded", "Forwarded many times"]);
    expect(labels[1]).toHaveAttribute("data-many", "true");
  });
});

describe("the Forward to… picker", () => {
  function Where() {
    return <p data-testid="where">{useLocation().pathname}</p>;
  }
  const open = (messages: ChatMessage[], from = "link-bo", language?: "pt" | "ar") => renderApp(<Routes>
    <Route path="/here" element={<ForwardDialog from={from} messages={messages} onClose={() => {}} />} />
    <Route path="*" element={<Where />} />
  </Routes>, { route: "/here", language });
  const names = () => screen.getAllByTestId("forward-target").map(row => row.querySelector("bdi")?.textContent);

  it("lists chats and the groups this device can write in, most recent first, and finds them by name", async () => {
    const { user } = open([message()]);
    expect(names()).toEqual(["Ana", "Friends", "Bo"]);
    await user.type(screen.getByTestId("forward-search"), "fri");
    expect(names()).toEqual(["Friends"]);
    await user.type(screen.getByTestId("forward-search"), "x");
    expect(screen.getByTestId("forward-none")).toHaveTextContent("No chat by that name");
  });

  it("says how many chats a settled search found, or that none has that name, once the typing settles", async () => {
    const { user } = open([message()]);
    const status = screen.getByTestId("forward-found");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("");
    await user.type(screen.getByTestId("forward-search"), "fri");
    expect(status).toHaveTextContent("");
    await waitFor(() => expect(status).toHaveTextContent("1 chat"));
    await user.type(screen.getByTestId("forward-search"), "x");
    await waitFor(() => expect(status).toHaveTextContent("No chat by that name"));
    await user.clear(screen.getByTestId("forward-search"));
    await waitFor(() => expect(status).toHaveTextContent(""));
  });

  it("says the count in the language's own forms (Arabic's dual)", async () => {
    const { user } = open([message()], "link-bo", "ar");
    await user.type(screen.getByTestId("forward-search"), "n");
    await waitFor(() => expect(screen.getByTestId("forward-found")).toHaveTextContent("محادثتان"));
    await user.type(screen.getByTestId("forward-search"), "x");
    await waitFor(() => expect(screen.getByTestId("forward-found")).toHaveTextContent("لا توجد محادثة بهذا الاسم"));
  });

  it("starts on its search; the down arrow goes on to the chats found, up from the first goes back", async () => {
    const { user } = open([message()]);
    const search = screen.getByTestId("forward-search");
    expect(search).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByTestId("forward-target")[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByTestId("forward-target")[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(search).toHaveFocus();
  });

  it("does not read the chats again on an engine change while it is open, only when one changes", async () => {
    open([message()]);
    await screen.findByText("Ana");
    const parse = JSON.parse;
    let reads = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"peerPubKeyB64"') && text.includes('"messages"')) reads++;
      return parse(text, reviver);
    });
    try {
      // The engine changes many times a second during a call or a file transfer: the picker must not re-read the chats.
      for (let i = 0; i < 5; i++) act(() => fakeEngine.setState(engineState({
        links: [linkView({ id: "link-ana", peerPubKeyZ32: "peer-ana" }), linkView({ id: "link-bo", peerPubKeyZ32: "peer-bo" })],
        groups: [groupView({ id: "g1", name: "Friends", lastMessageAt: 2_000 + i }), groupView({ id: "g2", name: "Readers", canSend: false })],
      })));
      expect(reads).toBe(0);
      // A chat changes (here its name): the list reads it once and shows the change.
      act(() => { chat("chat-ana", "peer-ana", "Ana II", 3_000); window.dispatchEvent(new Event("session-updated")); });
      await screen.findByText("Ana II");
      expect(reads).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("offers the groups for a file too (WISP 503), and forwards it there", async () => {
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: ["x"], error: null })) }));
    const { user } = open([message({ text: "", file: PICTURE })]);
    expect(names()).toEqual(["Ana", "Friends", "Bo"]);
    expect(screen.queryByTestId("forward-files-hint")).toBeNull();
    await user.click(screen.getAllByTestId("forward-target")[1]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([{ linkId: "link-bo", messageIds: ["m1"], to: ["group:g1"] }]);
    expect(await screen.findByTestId("where")).toHaveTextContent("/group/g1");
  });

  it("sends to the chosen ones and, for one, opens it", async () => {
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: ["me_1"], error: null })) }));
    const { user } = open([message()]);
    expect(screen.getByTestId("forward-send")).toBeDisabled();
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    expect(screen.getAllByTestId("forward-target")[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent("Ana");
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([{ linkId: "link-bo", messageIds: ["m1"], to: ["link-ana"] }]);
    // The chat opens once the engine answered, and the router renders a navigation as a transition, which React may
    // split over several tasks on a busy machine: waited for, not read at once.
    expect(await screen.findByTestId("where")).toHaveTextContent("/chat/chat-ana");
  });

  it("takes at most five, and says what a chat refused", async () => {
    for (const n of [1, 2, 3, 4]) chat(`chat-${n}`, `peer-${n}`, `P${n}`, 500 - n);
    fakeEngine.update({ links: ["ana", "bo", "1", "2", "3", "4"].map(n => linkView({ id: `link-${n}`, peerPubKeyZ32: `peer-${n}` })) });
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: t === "group:g1" ? "You are not in this group" : null })) }));
    const { user } = open([message()]);
    const rows = screen.getAllByTestId("forward-target");
    for (const row of rows.slice(0, 5)) await user.click(row);
    expect(rows[5]).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")[0]).toMatchObject({ to: ["link-ana", "group:g1", "link-bo", "link-1", "link-2"] });
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Friends: You are not in this group");
    expect(screen.queryByTestId("where")).toBeNull();
  });

  // At five chosen every other row went grey with nothing on screen or read aloud saying why: "Pick up to 5" was gone
  // once a chat was chosen (agents#2811).
  it("at five chosen says why the others wait, read once, and the others point at that line", async () => {
    for (const n of [1, 2, 3, 4]) chat(`chat-${n}`, `peer-${n}`, `P${n}`, 500 - n);
    fakeEngine.update({ links: ["ana", "bo", "1", "2", "3", "4"].map(n => linkView({ id: `link-${n}`, peerPubKeyZ32: `peer-${n}` })) });
    const { user } = open([message()]);
    const rows = screen.getAllByTestId("forward-target");
    for (const row of rows.slice(0, 4)) await user.click(row);
    expect(rows[5]).not.toHaveAttribute("aria-disabled");
    await user.click(rows[4]!);
    // Still reachable by the keys, as the app's other unavailable controls, so the reason is read on it.
    expect(rows[5]).toHaveAttribute("aria-disabled", "true");
    expect(rows[5]).toBeEnabled();
    const limit = screen.getByTestId("forward-limit");
    expect(limit).toHaveTextContent(/^You can forward to 5 chats at a time$/);
    expect(limit).toBeVisible();
    expect(limit).toHaveAttribute("aria-live", "polite");
    expect(rows[5]!.getAttribute("aria-describedby")).toBe(limit.id);
    expect(rows[6]!.getAttribute("aria-describedby")).toBe(limit.id);
    expect(rows[0]).not.toHaveAttribute("aria-describedby");
    // The live region was there, empty, before the limit: its text appearing is what is read, and only once.
    const said: string[] = [];
    const recorder = new MutationObserver(() => said.push(limit.textContent ?? ""));
    recorder.observe(limit, { childList: true, subtree: true, characterData: true });
    try {
      await user.click(rows[5]!);
      rows[6]!.focus();
      await user.keyboard(" ");
      expect(rows[5]).toHaveAttribute("aria-checked", "false");
      expect(rows[6]).toHaveAttribute("aria-checked", "false");
      expect(said).toEqual([]);
      await user.click(rows[0]!);
      expect(limit).toHaveTextContent(/^$/);
      expect(rows[5]).not.toHaveAttribute("aria-disabled");
      expect(rows[5]).not.toHaveAttribute("aria-describedby");
      await user.click(rows[5]!);
      expect(rows[5]).toHaveAttribute("aria-checked", "true");
      expect(limit).toHaveTextContent(/^You can forward to 5 chats at a time$/);
    } finally { recorder.disconnect(); }
  });

  it("the live region for the limit is there and empty before anything is chosen", () => {
    open([message()]);
    const limit = screen.getByTestId("forward-limit");
    expect(limit).toHaveAttribute("aria-live", "polite");
    expect(limit).toHaveTextContent(/^$/);
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent(/^Pick up to 5$/);
  });

  // The chosen names were one cut line with no title: 660 px of names in 204 px on a phone in Arabic.
  it("names five long chats in a short visible form, the whole list read aloud and in its title", async () => {
    const long = ["Ana Beatriz de Albuquerque Figueiredo", "Bo Lindqvist-Hallström", "Cy Montgomery-Worthington", "محمد عبد الرحمن الهاشمي", "山田花子とその仲間たち"];
    long.forEach((name, i) => chat(`chat-${i}`, `peer-${i}`, name, 900 - i));
    fakeEngine.update({ links: long.map((_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: `peer-${i}` })) });
    const { user } = open([message()], "link-bo", "ar");
    for (const name of long) await user.click(screen.getAllByTestId("forward-target").find(r => r.querySelector("bdi")?.textContent === name)!);
    const line = screen.getByTestId("forward-chosen");
    const short = within(line).getByTestId("names-short"), full = within(line).getByTestId("names-full");
    expect(short).toHaveAttribute("aria-hidden", "true");
    expect([...short.querySelectorAll("bdi")].map(b => b.textContent)).toEqual(long.slice(0, 2));
    expect(short).toHaveTextContent(new RegExp(`^${long[0]} و${long[1]} و3 محادثات أخرى$`));
    expect(full).toHaveClass("sr-only");
    expect([...full.querySelectorAll("bdi")].map(b => b.textContent)).toEqual(long);
    expect(line.getAttribute("title")).toBe(`⁨${long[0]}⁩ و⁨${long[1]}⁩ و⁨${long[2]}⁩ و⁨${long[3]}⁩ و⁨${long[4]}⁩`);
    expect(line).toHaveClass("line-clamp-2");
    expect(line).not.toHaveClass("truncate");
    expect(screen.getByTestId("forward-limit")).toHaveTextContent(/^يمكنك إعادة التوجيه إلى 5 محادثات في المرة الواحدة$/);
  });

  it("names three chats in full, with nothing said twice", async () => {
    const { user } = open([message()]);
    for (const row of screen.getAllByTestId("forward-target")) await user.click(row);
    const line = screen.getByTestId("forward-chosen");
    expect(within(line).queryByTestId("names-short")).toBeNull();
    expect(line).toHaveTextContent(/^Ana, Friends, Bo$/);
  });

  it("says what a chat refused in the app's language, not the engine's English", async () => {
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: "You are offline" })) }));
    const { user } = open([message({ text: "", file: PICTURE })], "link-bo", "pt");
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("forward-error")).toHaveTextContent(/^Ana: Você está offline/);
    expect(screen.getByTestId("forward-error")).not.toHaveTextContent("You are offline");
  });

  it("Send pressed from the keyboard keeps the focus while it runs, so a refusal leaves it on Send", async () => {
    // A focused button that turns disabled loses the focus to the page in a browser: after a refusal Enter did nothing,
    // and Send was back only through the search field and every row.
    type Results = { results: { to: string; messageIds: string[]; error: string | null }[] };
    let answer: (value: Results) => void = () => {};
    fakeEngine.on("forwardMessages", () => new Promise<Results>(resolve => { answer = resolve; }));
    const { user } = open([message()]);
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    const send = screen.getByTestId("forward-send");
    send.focus();
    await user.keyboard("{Enter}");
    expect(send).toBeEnabled();
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Enter}");
    expect(fakeEngine.callsTo("forwardMessages")).toHaveLength(1);
    await act(async () => answer({ results: [{ to: "link-ana", messageIds: [], error: "You are offline" }] }));
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Ana: You are offline");
    expect(send).not.toHaveAttribute("aria-disabled");
    expect(send).toHaveFocus();
  });

  it("after a chat refused, says where it went, and Send again goes only to the chats that refused", async () => {
    let refuse = true;
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: t === "link-bo" && refuse ? [] : ["me_1"], error: t === "link-bo" && refuse ? "You are offline" : null })) }));
    const { user } = open([message()], "link-1");
    const rows = screen.getAllByTestId("forward-target");
    await user.click(rows[0]!);
    await user.click(rows[2]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Bo: You are offline");
    expect(screen.getByTestId("forward-sent")).toHaveTextContent("Sent to Ana");
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent(/^Bo$/);
    expect(rows[0]).toHaveAttribute("aria-checked", "false");
    refuse = false;
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages").map(c => (c as { to: string[] }).to)).toEqual([["link-ana", "link-bo"], ["link-bo"]]);
  });

  // Send again forwarded the part a chat got already a second time, and a group's 9th file on could never go: every
  // Send again posted files 1-8 again and hit the pace at the 9th (agents#1082).
  it("says how much of it a chat got, and Send again sends that chat only the rest", async () => {
    const all = [message({ id: "a", text: "dinner at eight", timestamp: 1 }), message({ id: "b", text: "📎 pic.png", file: PICTURE, timestamp: 2 })];
    let full = true;
    fakeEngine.on("forwardMessages", ({ to, messageIds }: { to: string[]; messageIds: string[] }) => ({ results: to.map(t => {
      const sent = t === "link-ana" && full ? messageIds.filter(id => id === "a") : messageIds;
      return { to: t, messageIds: sent.map(id => `me_${id}`), sent, error: sent.length < messageIds.length ? "Not enough space on this device" : null };
    }) }));
    const { user } = open(all, "link-1");
    const rows = screen.getAllByTestId("forward-target");
    await user.click(rows[0]!);
    await user.click(rows[2]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Ana (1 of 2 sent): Not enough space on this device");
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent(/^Ana$/);
    full = false;
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([
      { linkId: "link-1", messageIds: ["a", "b"], to: ["link-ana", "link-bo"] },
      { linkId: "link-1", messageIds: ["b"], to: ["link-ana"] },
    ]);
    expect(screen.queryByTestId("forward-error")).toBeNull();
  });

  // In one Arabic string a Latin name's end punctuation went to the line's side: "Ana!" read "!Ana", and the chosen names
  // ran in English order. Each name is isolated, as in the rows above.
  it("keeps each chat's name in its own direction in an Arabic line", async () => {
    chat("chat-ana", "peer-ana", "Ana!", 3_000);
    chat("chat-bo", "peer-bo", "Bo?", 1_000);
    const all = [message({ id: "a", timestamp: 1 }), message({ id: "b", timestamp: 2 })];
    fakeEngine.on("forwardMessages", ({ to, messageIds }: { to: string[]; messageIds: string[] }) => ({ results: to.map(t => {
      const sent = t === "link-ana" ? ["a"] : t === "group:g1" ? messageIds : [];
      return { to: t, messageIds: sent.map(id => `me_${id}`), sent, error: sent.length < messageIds.length ? "You are offline" : null };
    }) }));
    const { user } = open(all, "link-1", "ar");
    const rows = screen.getAllByTestId("forward-target");
    for (const row of rows) await user.click(row);
    const isolated = (id: string) => [...screen.getByTestId(id).querySelectorAll("bdi")].map(b => b.textContent);
    expect(isolated("forward-chosen")).toEqual(["Ana!", "Friends", "Bo?"]);
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent(/^Ana! وFriends وBo\?$/);
    await user.click(screen.getByTestId("forward-send"));
    const lines = within(screen.getByTestId("forward-error")).getAllByRole("listitem");
    expect(lines.map(line => line.querySelector("bdi")?.textContent)).toEqual(["Ana!", "Bo?"]);
    expect(lines[0]).toHaveTextContent("Ana! (أُرسل 1 من 2): ");
    // Read out as an alert and still as a list of 2: the alert on the list itself took the list away from its lines.
    expect(screen.getByTestId("forward-error")).toHaveAttribute("role", "alert");
    expect(await axeViolations(screen.getByRole("dialog"))).toEqual([]);
    expect(isolated("forward-sent")).toEqual(["Friends"]);
    expect(screen.getByTestId("forward-sent")).toHaveTextContent(/^أُرسل إلى Friends$/);
    expect(isolated("forward-chosen")).toEqual(["Ana!", "Bo?"]);
    // Listed the Arabic way, not with an English comma.
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent(/^Ana! وBo\?$/);
  });

  // Send again sends one call per set of owed messages: a chat that got everything was called with none, which the engine
  // refuses ("No message to forward"), and that one refusal, in English with no name, hid what the other call delivered.
  it("a chat that got everything, ticked again, is not sent anything again nor called with nothing", async () => {
    const all = [message({ id: "a", text: "dinner at eight", timestamp: 1 }), message({ id: "b", text: "📎 pic.png", file: PICTURE, timestamp: 2 })];
    let offline = true;
    fakeEngine.on("forwardMessages", ({ to, messageIds }: { to: string[]; messageIds: string[] }) => {
      if (!messageIds.length) throw new Error("No message to forward");
      return { results: to.map(t => t === "link-bo" && offline
        ? { to: t, messageIds: [], sent: [], error: "You are offline" }
        : { to: t, messageIds: messageIds.map(id => `me_${id}`), sent: messageIds, error: null }) };
    });
    const { user } = open(all, "link-1", "pt");
    const rows = screen.getAllByTestId("forward-target");
    await user.click(rows[0]!);
    await user.click(rows[2]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("forward-sent")).toHaveTextContent("Enviado para Ana");
    await user.click(rows[0]!);
    offline = false;
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([
      { linkId: "link-1", messageIds: ["a", "b"], to: ["link-ana", "link-bo"] },
      { linkId: "link-1", messageIds: ["a", "b"], to: ["link-bo"] },
    ]);
    expect(screen.queryByTestId("forward-error")).toBeNull();
  });

  it("a call that is refused keeps what the other calls delivered, and says the refusal under its chats' names", async () => {
    chat("chat-cy", "peer-cy", "Cy", 2_500);
    fakeEngine.update({ links: ["ana", "bo", "cy"].map(n => linkView({ id: `link-${n}`, peerPubKeyZ32: `peer-${n}` })) });
    const all = [message({ id: "a", text: "dinner at eight", timestamp: 1 }), message({ id: "b", text: "📎 pic.png", file: PICTURE, timestamp: 2 })];
    let first = true;
    fakeEngine.on("forwardMessages", ({ to, messageIds }: { to: string[]; messageIds: string[] }) => {
      if (first) {
        first = false;
        // Ana gets the text, the picture finds no room; Cy is offline.
        return { results: to.map(t => t === "link-ana"
          ? { to: t, messageIds: ["me_a"], sent: ["a"], error: "Not enough space on this device" }
          : { to: t, messageIds: [], sent: [], error: "You are offline" }) };
      }
      // The text was deleted from this chat meanwhile: a call that names it is refused whole.
      if (messageIds.includes("a")) throw new Error("That message is not in this chat");
      return { results: to.map(t => ({ to: t, messageIds: messageIds.map(id => `me_${id}`), sent: messageIds, error: null })) };
    });
    const { user } = open(all, "link-1", "pt");
    const row = (name: string) => screen.getAllByTestId("forward-target").find(r => r.textContent?.includes(name))!;
    await user.click(row("Ana"));
    await user.click(row("Cy"));
    await user.click(screen.getByTestId("forward-send"));
    await user.click(screen.getByTestId("forward-send"));
    const said = screen.getByTestId("forward-error");
    expect(said).toHaveTextContent(/^Cy: Essa mensagem não está mais nesta conversa/);
    expect(said).not.toHaveTextContent("That message");
    expect(screen.getByTestId("forward-sent")).toHaveTextContent("Enviado para Ana");
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent(/^Cy$/);
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([
      { linkId: "link-1", messageIds: ["a", "b"], to: ["link-ana", "link-cy"] },
      { linkId: "link-1", messageIds: ["b"], to: ["link-ana"] },
      { linkId: "link-1", messageIds: ["a", "b"], to: ["link-cy"] },
      { linkId: "link-1", messageIds: ["a", "b"], to: ["link-cy"] },
    ]);
  });

  // The engine's line for a copy that found no room on this device, however the storage said it (engine/forwards.ts
  // forwardError): IndexedDB, the OPFS worker, Desktop's io error. Said in the app's language, never as sent.
  it.each([
    "Not enough space on this device (QuotaExceededError)",
    "Not enough space on this device (QuotaExceededError: This device has no space left for the file)",
    "Not enough space on this device (No space left on device (os error 28))",
  ])("says a copy found no room in the app's language: %s", async (error) => {
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error })) }));
    const { user } = open([message({ text: "", file: PICTURE })], "link-bo", "pt");
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Ana: Não há espaço suficiente neste dispositivo. Libere espaço e tente de novo.");
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("never takes an empty error for a success", async () => {
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: "" })) }));
    const { user } = open([message({ text: "", file: PICTURE })], "link-bo", "pt");
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Ana: Algo deu errado");
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("asks before forwarding text that looks like a seed, as typing it would", async () => {
    expect(forwardSecret([message({ text: SEED })])).toMatchObject({ kind: "mnemonic" });
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: null })) }));
    const { user } = open([message({ text: SEED })]);
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("secret-guard")).toHaveAttribute("data-kind", "mnemonic");
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([]);
    await user.click(screen.getByTestId("forward-send"));
    await user.click(screen.getByTestId("secret-guard-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toHaveLength(1);
  });

  // The guard is the picker's child in React's tree (portalled out of it): React handed the guard's cancel to the
  // picker's too, and one Escape closed both, the chosen chats with them.
  it("Escape on the seed question closes only the question: the picker stays with its chats chosen", async () => {
    const onClose = vi.fn();
    const { user } = renderApp(<ForwardDialog from="link-bo" messages={[message({ text: SEED })]} onClose={onClose} />);
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    // The browser's cancel on Escape: on the dialog, not bubbling.
    act(() => { screen.getByTestId("secret-guard").dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(screen.queryByTestId("secret-guard")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent("Ana");
    // The next Escape is the picker's.
    act(() => { screen.getByTestId("forward-dialog").dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("choosing several", () => {
  function Timeline({ messages }: { messages: ChatMessage[] }) {
    const forwarding = useForwarding("link-bo", messages);
    return <>
      {messages.map(m => <MessageBubble key={m.id} message={m} peerPubKey="peer" onDelete={() => {}} {...forwarding.rowProps(m)} />)}
      {forwarding.bar}
      {forwarding.dialog}
    </>;
  }
  const messages = [message({ id: "a", text: "first", timestamp: 1 }), message({ id: "p", paymentId: "pay-1", timestamp: 2 }), message({ id: "b", text: "second", timestamp: 3 })];

  it("Select starts it; rows become checkboxes, a payment cannot be chosen, Forward takes them in order", async () => {
    const { user } = renderApp(<Timeline messages={messages} />);
    await user.click(screen.getAllByTestId("message-options")[2]!);
    await user.click(screen.getByTestId("message-select-start"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("1 selected");
    // The rows' menus wait while messages are chosen.
    expect(screen.queryAllByTestId("message-options")).toHaveLength(0);
    const boxes = screen.getAllByTestId("message-select");
    expect(boxes.map(b => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(boxes[1]).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByText("first"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("2 selected");
    await user.click(screen.getByTestId("select-forward"));
    const dialog = screen.getByTestId("forward-dialog");
    expect(within(dialog).getByTestId("forward-count")).toHaveTextContent("2 messages");
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: null })) }));
    await user.click(within(dialog).getAllByTestId("forward-target")[0]!);
    await user.click(within(dialog).getAllByTestId("forward-target")[1]!);
    await user.click(within(dialog).getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([{ linkId: "link-bo", messageIds: ["a", "b"], to: ["link-ana", "group:g1"] }]);
    // Sent: the choice is over.
    expect(screen.queryByTestId("select-bar")).toBeNull();
  });

  it("Escape, ✕ or taking the last one off ends it", async () => {
    const { user } = renderApp(<Timeline messages={messages} />);
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    // An Escape something else answered (a menu, a field) is not the choice's.
    const spent = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    spent.preventDefault();
    act(() => { window.dispatchEvent(spent); });
    expect(screen.getByTestId("select-bar")).toBeInTheDocument();
    // The one that ends it is spent: a notice at the top that also answers Escape stays.
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    act(() => { window.dispatchEvent(escape); });
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    await user.click(screen.getByTestId("select-cancel"));
    expect(screen.queryByTestId("select-bar")).toBeNull();
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    fireEvent.click(screen.getByText("first"));
    expect(screen.queryByTestId("select-bar")).toBeNull();
  });

  // A <dialog> opened over the chat while messages were chosen (Delete chat from the header's ⋮): the browser closes it
  // on the Escape's default action, which the choice's own listener cancelled. The first Escape ended the choice behind
  // and left the dialog open.
  it("an Escape in a dialog over the chat is the dialog's: the choice stays, and the key is not cancelled", async () => {
    const { user } = renderApp(<Timeline messages={messages} />);
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.setAttribute("open", "");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { dialog.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(false);
    expect(screen.getByTestId("select-bar")).toBeInTheDocument();
    dialog.remove();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
    expect(screen.queryByTestId("select-bar")).toBeNull();
  });

  /** The chat's column as the pages lay it out: the list, the bar, and the composer, kept but hidden while messages are chosen. */
  function Column({ disabled = false }: { disabled?: boolean }) {
    const forwarding = useForwarding("link-bo", messages);
    return <div>
      <button type="button" data-testid="elsewhere">Search</button>
      <div data-message-list>{messages.map(m => <MessageBubble key={m.id} message={m} peerPubKey="peer" onDelete={() => {}} {...forwarding.rowProps(m)} />)}</div>
      {forwarding.bar}
      {forwarding.dialog}
      <div className={forwarding.selecting ? "hidden" : "contents"}><textarea data-testid="field" aria-label="Message" disabled={disabled} /></div>
    </div>;
  }
  /** A touch screen with no mouse (`any-pointer` coarse, never fine), or a mouse. */
  function pointer(touch: boolean) {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(any-pointer: coarse)" || query === "(any-pointer: fine)"
        ? ({ ...matchMedia(query), matches: query === "(any-pointer: coarse)" ? touch : !touch } as MediaQueryList)
        : matchMedia(query));
  }
  const select = async (user: ReturnType<typeof renderApp>["user"]) => {
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
  };

  it("ended from the keyboard, the focus goes to the message field that comes back, not to the page", async () => {
    pointer(false);
    const { user } = renderApp(<Column />);
    await select(user);
    screen.getByTestId("select-cancel").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("field"));

  });

  it("after a forward of the chosen messages went, the focus is on the message field too", async () => {
    pointer(false);
    const { user } = renderApp(<Column />);
    await select(user);
    screen.getByTestId("select-forward").focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByTestId("forward-dialog");
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: null })) }));
    await user.click(within(dialog).getAllByTestId("forward-target")[0]!);
    await user.click(within(dialog).getAllByTestId("forward-target")[1]!);
    await user.click(within(dialog).getByTestId("forward-send"));
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("field"));
  });

  it("on a touch screen the focus goes to the messages: the field would bring the keyboard up", async () => {
    pointer(true);
    const { user } = renderApp(<Column />);
    await select(user);
    screen.getByTestId("select-cancel").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-message-list]"));
  });

  it("where the field takes no text the focus goes to the messages, a stop only while they hold it", async () => {
    pointer(false);
    const { user } = renderApp(<Column disabled />);
    await select(user);
    screen.getByTestId("select-cancel").focus();
    await user.keyboard("{Enter}");
    const list = document.querySelector("[data-message-list]");
    expect(document.activeElement).toBe(list);
    screen.getByTestId("elsewhere").focus();
    expect(list).not.toHaveAttribute("tabindex");
  });

  it("a focus the person moved elsewhere, or that a message's row kept, is left alone", async () => {
    pointer(false);
    const { user } = renderApp(<Column />);
    await select(user);
    screen.getByTestId("elsewhere").focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("elsewhere"));

    // The last one taken off from its checkbox: the row keeps the focus its checkbox had.
    await select(user);
    screen.getAllByTestId("message-select")[0]!.focus();
    await user.keyboard(" ");
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-message-id=a]"));
  });
});

describe("the names a forward lists (agents#2811)", () => {
  const seven = ["Ana Beatriz de Albuquerque", "Bo Lindqvist-Hallström", "Cy Montgomery", "Dee Okonkwo-Adeyemi", "Eve Lindgren", "Fay Nakamura-Oliveira", "Gus Papadopoulos"];

  it("seven long names: two and how many more on screen, all seven for a screen reader, each in its own direction", () => {
    renderApp(<p data-testid="line"><NameList names={seven} /></p>);
    const short = screen.getByTestId("names-short"), full = screen.getByTestId("names-full");
    expect(short).toHaveAttribute("aria-hidden", "true");
    expect(short).toHaveTextContent(/^Ana Beatriz de Albuquerque, Bo Lindqvist-Hallström, 5 more$/);
    expect([...full.querySelectorAll("bdi")].map(b => b.textContent)).toEqual(seven);
    expect(full).toHaveClass("sr-only");
  });

  it("says how many more in the app's language", () => {
    renderApp(<p data-testid="line"><NameList names={seven} /></p>, { language: "pt" });
    expect(screen.getByTestId("names-short")).toHaveTextContent(/^Ana Beatriz de Albuquerque, Bo Lindqvist-Hallström, mais 5$/);
  });

  const ar = translateWith(LOCALES.ar, "ar");
  it.each([
    [1, "محادثة أخرى", "يمكنك إعادة التوجيه إلى محادثة واحدة في المرة الواحدة"],
    [2, "محادثتان أخريان", "يمكنك إعادة التوجيه إلى محادثتين في المرة الواحدة"],
    [3, "3 محادثات أخرى", "يمكنك إعادة التوجيه إلى 3 محادثات في المرة الواحدة"],
    [11, "11 محادثة أخرى", "يمكنك إعادة التوجيه إلى 11 محادثة في المرة الواحدة"],
  ] as const)("Arabic counts %d more chats and a limit of as many as a person reads them", (count, more, limit) => {
    expect(ar("chat.forward.more", { count: String(count) })).toBe(more);
    expect(ar("chat.forward.limit", { count: String(count) })).toBe(limit);
  });

  it("English and French say one chat in the singular", () => {
    const en = translateWith(LOCALES.en, "en"), fr = translateWith(LOCALES.fr, "fr");
    expect(en("chat.forward.limit", { count: "1" })).toBe("You can forward to 1 chat at a time");
    expect(en("chat.forward.limit", { count: "5" })).toBe("You can forward to 5 chats at a time");
    expect(fr("chat.forward.more", { count: "1" })).toBe("1 autre");
    expect(fr("chat.forward.more", { count: "4" })).toBe("4 autres");
  });
});
