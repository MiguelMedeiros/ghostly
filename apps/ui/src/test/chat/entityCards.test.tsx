import { act, screen, waitFor, within, render } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi, afterAll, type MockInstance } from "vitest";
import { createChatInvite, encodeCommunityLink, encodeGroupEntryLink, inviteLink, randomBytes, toBase64Url, toZ32, DidError } from "@ghostly/core";
import { neventEncode, npubEncode } from "nostr-tools/nip19";
import { MessageBubble } from "../../components/MessageBubble";
import { ensureSession, listSessions, updateSessionLabel } from "../../lib/storage";
import { groupView, linkView, fakeEngine, type StatePatch } from "../fakeEngine";
import { lookup } from "../i18n/locales";
import { receivedView, identitiesView } from "../identities/views";
import { renderApp } from "../render";
import type { Language } from "../../lib/settings";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EntityCardFrame } from "../../components/chat/EntityCardFrame";
import { loadIdentityProviders } from "@ghostly/browser/proofs/load";
import { providerOf } from "../../lib/identities";
import { Profiler } from "react";

// covers: chat.cards.invite, chat.cards.group, chat.cards.nostr, chat.cards.identity, invite.own, invite.rejoin

/** `listSessions()` calls with no cache: each parses every chat's stored copy and merges a long chat's whole history in. */
const uncached = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../lib/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/storage")>();
  return { ...real, listSessions: (...a: Parameters<typeof real.listSessions>) => { if (!a[0]) uncached.n++; return real.listSessions(...a); } };
});

const hex = () => Array.from(randomBytes(32), b => b.toString(16).padStart(2, "0")).join("");
const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

/** A message from the contact Alice (or from this profile, `mine`), rendered in a chat with her. */
function bubble(text: string, { mine = false, forwarded, language }: { mine?: boolean; forwarded?: number; language?: Language } = {}) {
  return renderApp(<>
    <MessageBubble message={{ id: "m1", text, sender: mine ? "me" : "peer", timestamp: 1_700_000_000_000, forwarded }} peerNick="Alice" peerPubKey="peer" />
    <Where />
  </>, { language });
}

describe("invite cards", () => {
  it("a contact's invite shows who sent it, joins only on a tap, and opens the new chat", async () => {
    const { inviteCode } = createChatInvite();
    const { user } = bubble(`Here: ${inviteLink(inviteCode)} see you`);
    const card = screen.getByTestId("entity-invite");
    expect(card).toHaveTextContent("From ~Alice");
    // The text stays as it was, link and all.
    expect(screen.getByTestId("message-text")).toHaveTextContent(`Here: ${inviteLink(inviteCode)} see you`);
    expect(listSessions()).toHaveLength(0);
    await user.click(within(card).getByTestId("entity-invite-join"));
    const [session] = listSessions();
    expect(session).toBeDefined();
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${session.id}`);
    // Joined now: the card opens that chat rather than offering a second one.
    await waitFor(() => expect(card).toHaveAttribute("data-outcome", "joined"));
    expect(within(card).queryByTestId("entity-invite-join")).toBeNull();
  });

  it("refuses this profile's own invite, and offers the chat that owns it", async () => {
    const { mine, inviteCode } = createChatInvite();
    const own = ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1" });
    const { user } = bubble(inviteCode, { mine: true });
    const card = screen.getByTestId("entity-invite");
    expect(card).toHaveAttribute("data-outcome", "own");
    expect(card).toHaveTextContent("You sent this");
    expect(within(card).getByTestId("entity-invite-own")).toHaveTextContent("This is your own invite");
    expect(within(card).queryByTestId("entity-invite-join")).toBeNull();
    await user.click(within(card).getByTestId("entity-invite-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${own}`);
    expect(listSessions()).toHaveLength(1);
  });

  it("opens the chat an invite already joined, with no second one", async () => {
    const { invite, inviteCode } = createChatInvite();
    const joined = ensureSession({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64, profile: "paired-chat/1" });
    const { user } = bubble(inviteCode);
    await user.click(within(screen.getByTestId("entity-invite")).getByTestId("entity-invite-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${joined}`);
    expect(listSessions()).toHaveLength(1);
  });

  it("copies the invite as its link and shows its QR, each on a click only, and joins nothing", async () => {
    const { inviteCode } = createChatInvite();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    // Sent bare: what is copied is still the link.
    const { user } = bubble(inviteCode);
    const card = screen.getByTestId("entity-invite");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByTestId("link-qr")).toBeNull();

    const copy = within(card).getByTestId("entity-invite-copy");
    expect(copy).toHaveTextContent("Copy");
    await user.click(copy);
    expect(writeText.mock.calls).toEqual([[inviteLink(inviteCode)]]);
    expect(copy).toHaveTextContent("Copied!");

    const show = within(card).getByRole("button", { name: "Show QR" });
    await user.click(show);
    const dialog = screen.getByRole("dialog", { name: "Chat invite" });
    expect(dialog).toHaveAccessibleDescription("Scan it with another device. Anyone who sees it can join.");
    expect(within(dialog).getByTestId("link-qr-code").querySelector("svg")).not.toBeNull();
    expect(within(dialog).getByRole("textbox", { name: "Link" })).toHaveValue(inviteLink(inviteCode));
    await user.click(within(dialog).getByTestId("link-qr-copy"));
    expect(writeText.mock.calls).toEqual([[inviteLink(inviteCode)], [inviteLink(inviteCode)]]);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("link-qr")).toBeNull();
    expect(show).toHaveFocus();
    expect(listSessions()).toHaveLength(0);
    expect(card).toHaveAttribute("data-outcome", "new");
  });

  it("offers Copy and Show QR on the sender's own card and on one already joined", () => {
    const made = createChatInvite();
    ensureSession({ seedB64: made.mine.seedB64, peerPubKeyB64: made.mine.peerPubKeyZ32, encKeyB64: made.mine.encKeyB64, profile: "paired-chat/1" });
    const other = createChatInvite();
    ensureSession({ seedB64: other.invite.seedB64, peerPubKeyB64: other.invite.peerPubKeyZ32, encKeyB64: other.invite.encKeyB64, profile: "paired-chat/1" });
    bubble(`${made.inviteCode} ${other.inviteCode}`, { mine: true });
    const [own, joined] = screen.getAllByTestId("entity-invite");
    expect(own).toHaveAttribute("data-outcome", "own");
    expect(joined).toHaveAttribute("data-outcome", "joined");
    for (const card of [own, joined]) {
      expect(within(card).getByTestId("entity-invite-copy")).toBeVisible();
      expect(within(card).getByTestId("entity-invite-qr")).toBeVisible();
    }
  });

  it("says so when the link could not be copied", async () => {
    const { inviteCode } = createChatInvite();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    document.execCommand = vi.fn(() => false);
    const { user } = bubble(inviteCode);
    await user.click(screen.getByTestId("entity-invite-copy"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copy did not work");
    expect(screen.getByTestId("entity-invite-copy")).toHaveTextContent("Copy");
  });

  it("reads no chat's messages when a chat changes, and still tells an invite joined since", async () => {
    for (let i = 0; i < 3; i++) ensureSession({ seedB64: `s${i}`, peerPubKeyB64: `p${i}`, encKeyB64: "k" });
    const made = createChatInvite(), other = createChatInvite();
    const own = ensureSession({ seedB64: made.mine.seedB64, peerPubKeyB64: made.mine.peerPubKeyZ32, encKeyB64: made.mine.encKeyB64, profile: "paired-chat/1" });
    const { user } = bubble(`${made.inviteCode} ${other.inviteCode}`);
    const [mine, theirs] = screen.getAllByTestId("entity-invite");
    expect(mine).toHaveAttribute("data-outcome", "own");
    uncached.n = 0;
    for (let i = 0; i < 5; i++) act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(uncached.n).toBe(0);
    const joined = ensureSession({ seedB64: other.invite.seedB64, peerPubKeyB64: other.invite.peerPubKeyZ32, encKeyB64: other.invite.encKeyB64, profile: "paired-chat/1" });
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(theirs).toHaveAttribute("data-outcome", "joined");
    await user.click(within(theirs).getByTestId("entity-invite-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${joined}`);
    await user.click(within(mine).getByTestId("entity-invite-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${own}`);
  });

  it("shows no card for a code with a typo", () => {
    const { inviteCode } = createChatInvite();
    bubble(`${inviteCode.slice(0, -1)}${inviteCode.endsWith("q") ? "p" : "q"}`);
    expect(screen.queryByTestId("entity-cards")).toBeNull();
  });

  it("shows no card for an invite or a Nostr code the text holds only inside a spoiler, and one for what shows outside it", () => {
    const { inviteCode } = createChatInvite();
    const npub = npubEncode(hex());
    for (const text of [`guess who: ||${inviteLink(inviteCode)}||`, `||${npub}||`, `> ||here: ${inviteCode}||`, `[||tap||](${inviteLink(inviteCode)})`]) {
      const view = bubble(text);
      expect(screen.queryByTestId("entity-cards"), text).toBeNull();
      view.unmount();
    }
    bubble(`${npub} and ||${inviteLink(inviteCode)}||`);
    expect(screen.getByTestId("entity-nostr")).toBeInTheDocument();
    expect(screen.queryByTestId("entity-invite")).toBeNull();
  });
});

describe("group cards", () => {
  const g = toBase64Url(randomBytes(16)), host = toZ32(randomBytes(32));

  it("joins through the link on a tap, and opens the group", async () => {
    const link = encodeGroupEntryLink({ g, host });
    const { user, engine } = bubble(`join us https://app.ghostly.tools/#/join/${link}`);
    engine.on("joinGroupByLink", () => ({ groupId: g }));
    const card = screen.getByTestId("entity-group");
    expect(card).toHaveTextContent("Group invite");
    expect(engine.callsTo("joinGroupByLink")).toEqual([]);
    await user.click(within(card).getByTestId("entity-group-join"));
    expect(engine.callsTo("joinGroupByLink")).toEqual([{ link }]);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/group/${g}`));
  });

  it("copies the group's link as its address and shows its QR, without joining", async () => {
    for (const link of [encodeGroupEntryLink({ g, host }), encodeCommunityLink({ g, host })]) {
      const address = `${window.location.origin}/#/join/${link}`;
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      const { user, engine, unmount } = bubble(link);
      const card = screen.getByTestId("entity-group");
      expect(writeText).not.toHaveBeenCalled();
      await user.click(within(card).getByTestId("entity-group-copy"));
      expect(writeText.mock.calls).toEqual([[address]]);
      await user.click(within(card).getByTestId("entity-group-qr"));
      const dialog = screen.getByTestId("link-qr");
      expect(within(dialog).getByTestId("link-qr-url")).toHaveValue(address);
      await user.click(within(dialog).getByTestId("link-qr-close"));
      expect(screen.queryByTestId("link-qr")).toBeNull();
      expect(engine.callsTo("joinGroupByLink")).toEqual([]);
      writeText.mockRestore();
      unmount();
    }
  });

  it("says why a join failed", async () => {
    const { user, engine } = bubble(encodeCommunityLink({ g, host }));
    engine.on("joinGroupByLink", () => { throw new Error("This group's link was turned off"); });
    expect(screen.getByTestId("entity-group")).toHaveTextContent("Community group");
    await user.click(screen.getByTestId("entity-group-join"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This group's link was turned off");
  });

  it("Join pressed from the keyboard keeps the focus while it runs, so a refusal leaves it on Join", async () => {
    // A focused button that turns disabled loses the focus to the page in a browser: Space then scrolled the chat.
    let refuse: (error: Error) => void = () => {};
    const { user, engine } = bubble(encodeCommunityLink({ g, host }));
    engine.on("joinGroupByLink", () => new Promise((_, reject) => { refuse = reject; }));
    const join = screen.getByTestId("entity-group-join");
    join.focus();
    await user.keyboard("{Enter}");
    expect(join).toHaveTextContent("Joining…");
    expect(join).toBeEnabled();
    expect(join).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(engine.callsTo("joinGroupByLink")).toHaveLength(1);
    await act(async () => refuse(new Error("This group's link was turned off")));
    expect(await screen.findByRole("alert")).toHaveTextContent("This group's link was turned off");
    expect(join).not.toHaveAttribute("aria-disabled");
    expect(join).toHaveFocus();
  });

  it("opens a group this profile is already in", async () => {
    const { user, engine } = bubble(encodeGroupEntryLink({ g, host }));
    engine.update({ groups: [groupView({ id: g, name: "Book club", status: "active" })] });
    const card = await screen.findByText("Book club");
    const frame = card.closest("[data-entity-card]") as HTMLElement;
    expect(within(frame).getByTestId("entity-group-copy")).toBeVisible();
    expect(within(frame).getByTestId("entity-group-qr")).toBeVisible();
    await user.click(within(frame).getByTestId("entity-group-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/group/${g}`);
    expect(engine.callsTo("joinGroupByLink")).toEqual([]);
  });

  it("lets someone removed from a community join again through the link, and never says they are in it", async () => {
    for (const [status, statusReason, says] of [
      ["removed", "You were removed from this group", "You were removed from this group"],
      ["lost", "Two members let people in at the same moment and yours did not count. Asking to be let in again…", "Two members let people in at once. Asking to be let in again…"],
    ] as const) {
      const link = encodeCommunityLink({ g, host });
      const { user, engine, unmount } = bubble(link);
      engine.update({ groups: [groupView({ id: g, name: "Book club", profile: "community", status, statusReason, canSend: false })] });
      engine.on("joinGroupByLink", () => ({ groupId: g }));
      const before = engine.callsTo("joinGroupByLink").length;
      const card = screen.getByTestId("entity-group");
      await waitFor(() => expect(card).toHaveAttribute("data-status", status));
      expect(card).not.toHaveAttribute("data-member");
      expect(card).toHaveTextContent("Book club");
      expect(card).not.toHaveTextContent("You are in this group.");
      expect(within(card).getByTestId("entity-group-out")).toHaveTextContent(says);
      expect(within(card).getByTestId("entity-group-open")).toBeVisible();
      expect(within(card).getByTestId("entity-group-join")).toHaveTextContent("Join again");
      await user.click(within(card).getByTestId("entity-group-join"));
      expect(engine.callsTo("joinGroupByLink").slice(before)).toEqual([{ link }]);
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/group/${g}`));
      unmount();
    }
  });

  it("tells someone out of a private group whose history is kept what to do, with no join the engine would refuse", async () => {
    for (const [status, statusReason, says] of [
      ["removed", "You were removed from this group", "You were removed from this group"],
      ["forked", "The membership history forked", "Group changes are paused"],
    ] as const) {
      const { user, engine, unmount } = bubble(encodeGroupEntryLink({ g, host }));
      engine.update({ groups: [groupView({ id: g, name: "Book club", status, statusReason, canSend: false })] });
      const card = screen.getByTestId("entity-group");
      await waitFor(() => expect(card).toHaveAttribute("data-status", status));
      expect(card).not.toHaveAttribute("data-member");
      expect(card).not.toHaveTextContent("You are in this group.");
      expect(within(card).getByTestId("entity-group-out")).toHaveTextContent(says);
      expect(within(card).getByTestId("entity-group-next")).toHaveTextContent("Delete from this device");
      expect(within(card).queryByTestId("entity-group-join")).toBeNull();
      expect(within(card).getByTestId("entity-group-copy")).toBeVisible();
      await user.click(within(card).getByTestId("entity-group-open"));
      expect(screen.getByTestId("where")).toHaveTextContent(`/group/${g}`);
      expect(engine.callsTo("joinGroupByLink")).toEqual([]);
      unmount();
    }
  });

  it("keeps the kept history of a forked community: its card opens it and offers no join", async () => {
    const { engine } = bubble(encodeCommunityLink({ g, host }));
    engine.update({ groups: [groupView({ id: g, name: "Book club", profile: "community", status: "forked", statusReason: "The membership history forked", canSend: false })] });
    const card = screen.getByTestId("entity-group");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "forked"));
    expect(card).not.toHaveTextContent("You are in this group.");
    expect(within(card).getByTestId("entity-group-out")).toHaveTextContent("Group changes are paused. The admin must re-form the group.");
    expect(within(card).queryByTestId("entity-group-join")).toBeNull();
    expect(within(card).queryByTestId("entity-group-next")).toBeNull();
    expect(within(card).getByTestId("entity-group-open")).toBeVisible();
  });

  it("offers a plain join for a group this profile left", async () => {
    const link = encodeGroupEntryLink({ g, host });
    const { user, engine } = bubble(link);
    engine.update({ groups: [groupView({ id: g, name: "Book club", status: "left", statusReason: "You left this group", canSend: false })] });
    engine.on("joinGroupByLink", () => ({ groupId: g }));
    const card = screen.getByTestId("entity-group");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "left"));
    expect(card).not.toHaveTextContent("You are in this group.");
    expect(within(card).queryByTestId("entity-group-open")).toBeNull();
    await user.click(within(card).getByTestId("entity-group-join"));
    expect(engine.callsTo("joinGroupByLink")).toEqual([{ link }]);
  });
});

describe("Nostr cards", () => {
  it("names the person's relays, asks nothing before the tap, then shows the profile", async () => {
    const pubkey = hex();
    const { user, engine } = bubble(`follow nostr:${npubEncode(pubkey)}`);
    engine.update({ nostr: { own: [], settings: { relays: ["wss://relay.one.example", "wss://relay.two.example"], autoLoadProfiles: false, publish: false } } });
    engine.on("nostrLookup", () => ({ fetchedAt: Math.floor(Date.now() / 1000), relays: ["wss://relay.one.example"], found: true, profile: { name: "Alice in Chains", handle: "alice", about: "Just here for the ghosts.", hasPicture: false, eventAt: 0, eventId: "e" } }));
    const card = screen.getByTestId("entity-nostr");
    await waitFor(() => expect(within(card).getByTestId("entity-nostr-where")).toHaveTextContent("relay.one.example, relay.two.example"));
    expect(engine.callsTo("nostrLookup")).toEqual([]);
    await user.click(within(card).getByTestId("entity-nostr-load"));
    expect(engine.callsTo("nostrLookup")).toEqual([{ type: "profile", pubkey }]);
    expect(await within(card).findByText("Alice in Chains")).toBeVisible();
    expect(within(card).getByTestId("entity-nostr-about")).toHaveTextContent("Just here for the ghosts.");
    expect(within(card).getByTestId("entity-nostr-source")).toHaveTextContent("From relay.one.example");
  });

  it("draws what the person wrote in its own direction: their name, about and note", async () => {
    const pubkey = hex(), id = hex();
    const profile = bubble(`nostr:${npubEncode(pubkey)}`, { language: "ar" });
    profile.engine.on("nostrLookup", () => ({ fetchedAt: 0, relays: ["wss://relay.one.example"], found: true, profile: { name: "Alice (dev)", about: "مرحبا بكم!", hasPicture: false, eventAt: 0, eventId: "e" } }));
    await profile.user.click(screen.getByTestId("entity-nostr-load"));
    // In the app's direction, "Alice (dev)" in Arabic was drawn "(Alice (dev", an Arabic about in English with its "!" at the far end.
    const title = (await screen.findByTestId("entity-nostr-title")).closest("p")!;
    expect(title).toHaveAttribute("dir", "auto");
    // Beside its mark and label, as the app lines them up: it wraps, so nothing is cut.
    expect(title.className).toMatch(/\btext-match-parent\b/);
    expect(screen.getByTestId("entity-nostr-about")).toHaveAttribute("dir", "auto");
    profile.unmount();

    const note = bubble(neventEncode({ id, author: pubkey }), { language: "ar" });
    note.engine.on("nostrLookup", () => ({ fetchedAt: 0, relays: ["wss://relay.one.example"], found: true, note: { id, author: pubkey, createdAt: 0, reply: false, content: "Hello world!", muted: false } }));
    await note.user.click(screen.getByTestId("entity-nostr-load"));
    expect(await screen.findByTestId("entity-nostr-note")).toHaveAttribute("dir", "auto");
  });

  it("looks a note up by id and author, never by the code's relay hints, and hides what the mute list hides", async () => {
    const id = hex(), author = hex();
    const { user, engine } = bubble(neventEncode({ id, author, relays: ["wss://somebody-elses.example"] }));
    engine.on("nostrLookup", () => ({ fetchedAt: 0, relays: ["wss://relay.one.example"], found: true, note: { id, author, createdAt: 0, reply: false, content: "", muted: true } }));
    const card = screen.getByTestId("entity-nostr");
    expect(card).toHaveTextContent("The relays this code names are not asked.");
    await user.click(within(card).getByTestId("entity-nostr-load"));
    expect(engine.callsTo("nostrLookup")).toEqual([{ type: "note", id, author }]);
    expect(await within(card).findByTestId("entity-nostr-muted")).toBeVisible();
  });

  it("says a note's age and when it was fetched in the app's language", async () => {
    const id = hex(), author = hex();
    const now = Math.floor(Date.now() / 1000);
    for (const [language, from, minutes, hours] of [
      ["pt", "De relay.one.example", "há 3 min.", "há 2 h · uma resposta"],
      ["ar", "من relay.one.example", "قبل 3 دقائق", "قبل ساعتين"],
      ["ja", "relay.one.example から", "3 分前", "2 時間前"],
    ] as const) {
      const { user, engine, unmount } = bubble(neventEncode({ id, author }), { language });
      engine.on("nostrLookup", () => ({ fetchedAt: now - 180, relays: ["wss://relay.one.example"], found: true, note: { id, author, createdAt: now - 7200, reply: true, content: "hi", muted: false } }));
      const card = screen.getByTestId("entity-nostr");
      await user.click(within(card).getByTestId("entity-nostr-load"));
      const source = await within(card).findByTestId("entity-nostr-source");
      await waitFor(() => expect(source).toHaveTextContent(from));
      expect(source).toHaveTextContent(minutes);
      expect(within(card).getByTestId("entity-nostr-age")).toHaveTextContent(hours);
      expect(card).not.toHaveTextContent(/ago|just now/);
      unmount();
    }
  });

  it("says when the relays could not be asked", async () => {
    const { user, engine } = bubble(npubEncode(hex()));
    engine.on("nostrLookup", () => { throw new Error("Offline: turn the network on first"); });
    await user.click(screen.getByTestId("entity-nostr-load"));
    expect(await screen.findByTestId("entity-nostr-error")).toHaveTextContent("Offline");
  });

  it("Load pressed from the keyboard keeps the focus while it runs", async () => {
    let refuse: (error: Error) => void = () => {};
    const { user, engine } = bubble(npubEncode(hex()));
    engine.on("nostrLookup", () => new Promise((_, reject) => { refuse = reject; }));
    const load = screen.getByTestId("entity-nostr-load");
    load.focus();
    await user.keyboard("{Enter}");
    expect(load).toBeEnabled();
    expect(load).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(engine.callsTo("nostrLookup")).toHaveLength(1);
    await act(async () => refuse(new Error("Offline: turn the network on first")));
    expect(await screen.findByTestId("entity-nostr-error")).toHaveTextContent("Offline");
    expect(load).not.toHaveAttribute("aria-disabled");
    expect(load).toHaveFocus();
  });
});

describe("identity cards", () => {
  beforeEach(() => {
    // happy-dom never scrolls: every card is in view.
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private fire: IntersectionObserverCallback) {}
      observe() { queueMicrotask(() => this.fire([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a did:key on this device once visible, and says no contact proved it", async () => {
    bubble(`my DID: ${DID_KEY}.`);
    const card = screen.getByTestId("entity-identity");
    expect(card).toHaveAttribute("data-provider", "did");
    expect(within(card).getByTestId("entity-identity-badge")).toHaveTextContent("Not proved in your chats");
    expect(await within(card).findByTestId("entity-identity-facts")).toHaveTextContent("did:key, the key is the identifier");
    expect(card).toHaveTextContent("Checked on this device");
  });

  it("says what it resolved in the app's language, as the Identities page does", async () => {
    bubble(DID_KEY, { language: "ar" });
    const ar = (key: string) => lookup("ar", `identities.providers.did.preview.${key}`)!;
    const facts = await within(screen.getByTestId("entity-identity")).findByTestId("entity-identity-facts");
    await waitFor(() => expect(facts).toHaveTextContent(ar("method")));
    expect(facts).toHaveTextContent(ar("keyIsIdentifier").replace("{{method}}", "did:key"));
    expect(facts).toHaveTextContent(ar("key"));
    expect(facts).not.toHaveTextContent(/Method|the key is the identifier|Key/);
  });

  it("carries the badge of the contact who proved it", async () => {
    const { engine } = bubble(DID_KEY);
    engine.update({ links: [linkView({ peerPubKeyZ32: "peer", identities: { support: true, shared: [], received: [receivedView({ provider: "did", subject: DID_KEY })] } })] });
    ensureSession({ seedB64: "s", peerPubKeyB64: "peer", encKeyB64: "k" });
    await waitFor(() => expect(screen.getByTestId("entity-identity")).toHaveAttribute("data-standing", "verified"));
    expect(screen.getByTestId("entity-identity-badge")).toHaveTextContent("Proved by");
  });

  it("reads no chat's messages on an engine state, and names the contact who proved it as the chat is named now", async () => {
    for (let i = 0; i < 3; i++) ensureSession({ seedB64: `s${i}`, peerPubKeyB64: `p${i}`, encKeyB64: "k" });
    const chat = ensureSession({ seedB64: "s", peerPubKeyB64: "peer", encKeyB64: "k" });
    updateSessionLabel(chat, "Ana");
    const { engine } = bubble(`${DID_KEY} did:web:example.com`);
    const proved = (at: number) => linkView({ peerPubKeyZ32: "peer", peerLastSeenAt: at, identities: { support: true, shared: [], received: [receivedView({ provider: "did", subject: DID_KEY })] } });
    act(() => engine.update({ links: [proved(0)] }));
    const [card, unproved] = screen.getAllByTestId("entity-identity");
    expect(within(card).getByTestId("entity-identity-badge")).toHaveTextContent("Proved by ~Ana");
    expect(unproved).toHaveAttribute("data-standing", "none");
    uncached.n = 0;
    // Presence changes: nothing the cards show.
    for (let i = 1; i <= 5; i++) act(() => engine.update({ links: [proved(i)] }));
    expect(uncached.n).toBe(0);
    updateSessionLabel(chat, "Bea");
    act(() => engine.update({ links: [proved(6)] }));
    expect(within(card).getByTestId("entity-identity-badge")).toHaveTextContent("Proved by ~Bea");
    expect(uncached.n).toBe(0);
  });

  it("marks this profile's own Ghostly DID", async () => {
    const dht = `did:dht:${toZ32(randomBytes(32))}`;
    const { engine } = bubble(dht, { mine: true });
    engine.update({ did: { id: dht } as never });
    await waitFor(() => expect(screen.getByTestId("entity-identity-badge")).toHaveTextContent("Your Ghostly DID"));
  });

  it("asks nothing for a Pubky key until the tap, and then only the Pkarr relays", async () => {
    const key = toZ32(randomBytes(32));
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => { asked.push(String(input)); throw new TypeError("offline in tests"); });
    const { user } = bubble(`pubky://${key}`);
    const card = screen.getByTestId("entity-identity");
    expect(card).toHaveTextContent("pkarr.pubky.org");
    await Promise.resolve();
    expect(asked).toEqual([]);
    await user.click(within(card).getByTestId("entity-identity-resolve"));
    expect(await within(card).findByTestId("entity-identity-error")).toHaveTextContent("Could not resolve it");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(url => /^https:\/\/pkarr\.pubky\.(org|app)\//.test(url))).toBe(true);
  });

  it("with Hide my IP on, offers no lookup of a did:web someone else chose, and asks its server nothing", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => { asked.push(String(input)); throw new TypeError("offline in tests"); });
    // A contact's, and a copy of one I forwarded: a server someone else chose.
    for (const shown of [{}, { mine: true, forwarded: 1 }]) {
      const { engine, unmount } = bubble("did:web:contact.example.com", shown);
      act(() => engine.update({ settings: { ...engine.state.settings, relayOnly: true } }));
      const card = screen.getByTestId("entity-identity");
      expect(within(card).queryByTestId("entity-identity-resolve")).toBeNull();
      expect(within(card).getByTestId("entity-identity-where")).toHaveTextContent("Hide my IP is on, so contact.example.com, a server your contact chose, isn't contacted.");
      unmount();
    }
    expect(asked).toEqual([]);
    // My own did:web, written here: Look it up stays, as my own picture links load.
    const { engine } = bubble("did:web:mine.example.com", { mine: true });
    act(() => engine.update({ settings: { ...engine.state.settings, relayOnly: true } }));
    expect(within(screen.getByTestId("entity-identity")).getByTestId("entity-identity-resolve")).toBeInTheDocument();
  });
});

// covers: app.accessibility
describe("EntityCardFrame: the label and the subtitle", () => {
  /**
   * A card's small label and its "From …"/"You sent" line are 11-12 px text in a tint of the text colour, on the card's
   * own tint over the bubble. They read at 4.5:1 or more on both bubbles of every theme, dark and light (at 65% they
   * were 3.54:1 on classic dark's sent bubble). The tints are read from the frame's classes, the colours from index.css.
   */
  const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = (c: number[]) => {
    const [r, g, b] = c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const over = (top: number[], alpha: number, base: number[]) => top.map((v, i) => v * alpha + base[i] * (1 - alpha));

  function themes(): [string, { text: string; received: string; sent: string }][] {
    const found = new Map<string, { text: string; received: string; sent: string }>();
    for (const [, mode, color, body] of CSS.matchAll(/\[data-theme="(dark|light)"\]\[data-color-theme="(\w+)"\]\s*\{([^}]*)\}/g)) {
      const token = (name: string) => body.match(new RegExp(`--theme-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
      const [text, received, sent] = [token("text-primary"), token("received-bg"), token("sent-bg")];
      if (text && received && sent && !found.has(`${color} ${mode}`)) found.set(`${color} ${mode}`, { text, received, sent });
    }
    return [...found];
  }

  const alpha = (el: Element, kind: "text" | "bg") => {
    const match = el.getAttribute("class")!.match(new RegExp(`(?:^|\\s)${kind}-text-primary(?:/(\\d+))?(?:\\s|$)`));
    expect(match, `${kind}-text-primary on ${el.getAttribute("class")}`).not.toBeNull();
    return match![1] ? Number(match![1]) / 100 : 1;
  };

  const { container } = render(<EntityCardFrame testId="card" mark={null} label="Chat invite" title="Private chat" subtitle="You sent" />);
  const card = container.querySelector("[data-entity-card]")!;
  const [label, , subtitle] = [...card.querySelectorAll("p")];

  it("the scan finds all four colour themes, dark and light", () => {
    expect(themes().map(([name]) => name).sort()).toEqual(
      ["classic dark", "classic light", "cyan dark", "cyan light", "monochrome dark", "monochrome light", "purple dark", "purple light"]);
  });

  it.each(themes())("read at 4.5:1 or more on %s's received and sent bubbles", (_, { text, received, sent }) => {
    for (const bubble of [received, sent]) {
      const back = over(rgb(text), alpha(card, "bg"), rgb(bubble));
      for (const line of [label, subtitle])
        expect(contrast(over(rgb(text), alpha(line, "text"), back), back), `${line.textContent} on ${bubble}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// covers: chat.cards.identity, app.i18n
describe("a DID card whose lookup found no usable document says why in the app's language", () => {
  /*
   * A DID card in a message says what it resolved in the app's language, but a lookup that found no usable document
   * said why in English in every language: "No DID document at https://…/did.json" for a did:web whose server has none,
   * "… is not JSON", and "This DID lists no Ed25519, secp256k1 or P-256 key …" for a document with no key that can sign.
   * The Add dialog's preview said them the same way.
   */

  const DID = "did:web:example.org";
  const URL_ = "https://example.org/.well-known/did.json";

  // Nothing leaves this machine: the lookup fails as the resolver throws it, before any fetch.
  let fetch: MockInstance<typeof globalThis.fetch>;
  beforeEach(() => { fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline in tests")); });
  afterEach(() => fetch.mockRestore());
  // A plain function, set once: the card's translated provider keeps the preview it was first made with, and the
  // config restores spies after each test.
  let failure: Error = new Error("unset");
  let real: unknown;
  const failWith = (e: Error) => {
    failure = e;
    const subject = providerOf("did")!.subject as { preview?: unknown };
    if (real === undefined) { real = subject.preview; subject.preview = async () => { throw failure; }; }
  };
  afterAll(() => { if (real !== undefined) (providerOf("did")!.subject as { preview?: unknown }).preview = real; });

  it.each([
    ["no did.json", `No DID document at ${URL_}`],
    ["a did.json that is not JSON", `${URL_} is not JSON`],
    ["a document with no key that can sign", "This DID lists no Ed25519, secp256k1 or P-256 key for authentication or assertionMethod, so it cannot sign"],
  ])("%s, in Arabic", async (_case, english) => {
    await loadIdentityProviders();
    failWith(new DidError(english));
    const { user } = renderApp(<MessageBubble message={{ id: "m1", text: DID, sender: "me", timestamp: 1_700_000_000_000 }} peerNick="Alice" peerPubKey="peer" />, { language: "ar" });
    const card = screen.getByTestId("entity-identity");
    await user.click(within(card).getByTestId("entity-identity-resolve"));
    const error = await within(card).findByTestId("entity-identity-error");
    expect(error.textContent).not.toMatch(/No DID document|is not JSON|lists no|cannot sign/);
    // The address stays, as a value.
    if (english.includes(URL_)) expect(error).toHaveTextContent(URL_);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// covers: chat.cards.identity, chat.cards.nostr, chat.cards.group
describe("entity cards on an engine state", () => {
  /**
   * The cards under a message (a DID, an npub, a group link) read the engine's state. The engine sends it anew on every
   * change, up to 20 times a second while a file moves: a card draws again only when what it shows changes.
   */

  const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const NPUB = npubEncode("a".repeat(64));
  const g = toBase64Url(randomBytes(16)), host = toZ32(randomBytes(32));
  const RELAYS = ["wss://relay.one.example"];
  /** The state as the engine sends it after a change elsewhere: the same content, every object new. */
  const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));
  const transfer = (i: number): StatePatch => ({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
  const nostr = (relays: string[]): StatePatch => ({ nostr: { own: [], settings: { relays, autoLoadProfiles: false, publish: false } } });

  function cards() {
    let draws = 0;
    const text = (id: string, t: string) => <MessageBubble message={{ id, text: t, sender: "peer", timestamp: 1_700_000_000_000 }} peerNick="Alice" peerPubKey="peer" />;
    renderApp(<Profiler id="cards" onRender={() => { draws++; }}>
      {text("m1", `my id ${DID_KEY}`)}
      {text("m2", `follow nostr:${NPUB}`)}
      {text("m3", encodeGroupEntryLink({ g, host }))}
    </Profiler>);
    return { draws: () => draws };
  }

  it("are not drawn again when nothing they show changed", async () => {
    fakeEngine.setState({ ...nostr(RELAYS), groups: [groupView({ id: g, name: "Book club", status: "active" })] });
    const { draws } = cards();
    // The identity providers load once (not part of the app's first load): their draw is not counted.
    await act(() => loadIdentityProviders());
    expect(await screen.findByText("Book club")).toBeVisible();
    const before = draws();
    for (let i = 0; i < 5; i++) sentAgain(transfer(i));
    // A group's change the card does not show (a new message in it) draws nothing either.
    sentAgain({ groups: [groupView({ id: g, name: "Book club", status: "active", lastMessageAt: 5, lastPeerMessageAt: 5 })] });
    expect(draws() - before).toBe(0);
  });

  it("are drawn again when what they show changes", async () => {
    fakeEngine.setState(nostr(RELAYS));
    cards();
    const identity = screen.getByTestId("entity-identity");
    expect(identity).toHaveAttribute("data-standing", "none");
    sentAgain({ links: [linkView({ peerPubKeyZ32: "peer", identities: identitiesView({ received: [receivedView({ id: "did", provider: "did", subject: DID_KEY })] }) })] });
    expect(identity).toHaveAttribute("data-standing", "verified");
    expect(within(screen.getByTestId("entity-nostr")).getByTestId("entity-nostr-where")).toHaveTextContent("relay.one.example");
    sentAgain(nostr(["wss://relay.two.example"]));
    expect(within(screen.getByTestId("entity-nostr")).getByTestId("entity-nostr-where")).toHaveTextContent("relay.two.example");
    expect(screen.getByTestId("entity-group")).not.toHaveAttribute("data-member");
    sentAgain({ groups: [groupView({ id: g, name: "Book club", status: "active" })] });
    expect(screen.getByTestId("entity-group")).toHaveAttribute("data-member", "true");
    expect(screen.getByTestId("entity-group")).toHaveTextContent("Book club");
  });
});
